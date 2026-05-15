// Cloudflare Worker entry point for the Simplex MCP server.
//
// Routes:
//   POST /mcp           — MCP Streamable HTTP transport
//   GET  /sse           — MCP SSE transport (legacy clients)
//   GET  /download/:key — HMAC-verified xlsx download
//   GET  /              — health check / landing

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { handleParse } from "./tools/parse";
import { handleSolve, type SolveEnv } from "./tools/solve";
import { problemSchema } from "./schemas/problem";
import { verifyAndStream } from "./storage/signing";

export interface Env extends SolveEnv {
  MCP_OBJECT: DurableObjectNamespace;
  // Shared bearer token. Required for any /mcp or /sse request.
  // Set via `wrangler secret put MCP_AUTH_TOKEN`.
  MCP_AUTH_TOKEN: string;
}

// Constant-time string compare so a wrong token can't leak length/prefix
// info via response timing.
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function checkBearer(req: Request, expected: string): boolean {
  const header = req.headers.get("Authorization") ?? "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  return constantTimeEquals(m[1].trim(), expected);
}

const UNAUTHORIZED_HEADERS = { "WWW-Authenticate": 'Bearer realm="simplex-mcp"' } as const;

// MCP Streamable HTTP requires `Accept: application/json, text/event-stream`
// on every client POST, and the `agents` library enforces this with a literal
// substring match. Some clients (notably ktor-based mobile apps like Kai 9000)
// send `Accept: */*` for JSON-RPC notifications, which gets rejected with 406
// even though the wildcard semantically covers both types. Rewrite to the
// canonical value so the notification reaches the handler.
function normalizeMcpAccept(req: Request): Request {
  if (req.method !== "POST") return req;
  const accept = req.headers.get("Accept") ?? "";
  if (accept.includes("application/json") && accept.includes("text/event-stream")) {
    return req;
  }
  const headers = new Headers(req.headers);
  headers.set("Accept", "application/json, text/event-stream");
  return new Request(req, { headers });
}

export class SimplexMCP extends McpAgent<Env> {
  server = new McpServer({
    name: "simplex-solver",
    version: "1.0.0",
  });

  async init() {
    this.server.registerTool(
      "parse_lp_text",
      {
        title: "Parse natural-language LP",
        description:
          "Parse a free-form natural-language description of a Linear Programming problem " +
          "(e.g. 'maximize Z = 3x + 2y subject to x + 2y <= 6, x, y >= 0') into the structured " +
          "Problem JSON consumed by `solve_simplex_problem`. Use when the user provides text; " +
          "skip when you already have structured input.",
        inputSchema: {
          text: z.string().min(1).describe(
            "Free-form LP statement. Supports max/min, fractional coefficients, ≤/≥/= operators.",
          ),
        },
      },
      async ({ text }) => handleParse(text),
    );

    this.server.registerTool(
      "solve_simplex_problem",
      {
        title: "Solve LP via Simplex (Big-M)",
        description:
          "Solve a Linear Programming problem with the Simplex Method, using the Big-M method " +
          "when artificial variables are required. Returns the full step-by-step solution as JSON " +
          "AND a downloadable Excel containing every tableau, pivot highlighting, exact " +
          "fractions, and a final solution block. Detects optimal / unbounded / infeasible cases.",
        inputSchema: problemSchema.shape,
      },
      async (input, extra) => {
        // The MCP SDK's `extra` carries protocol metadata; the originating
        // request URL lives on `extra.requestInfo` (Streamable HTTP) — used
        // for building the absolute /download URL. Falls back to relative.
        const reqInfo = (extra as unknown as { requestInfo?: { url?: string } }).requestInfo;
        return handleSolve(input as z.infer<typeof problemSchema>, this.env, reqInfo);
      },
    );
  }
}

// McpAgent.serve() returns a Worker handler { fetch } for the Streamable HTTP
// transport (single endpoint, modern MCP spec). serveSSE() exposes the legacy
// SSE transport for older clients. Both share the same Durable Object class.
const mcpHandler = SimplexMCP.serve("/mcp", { binding: "MCP_OBJECT" });
const sseHandler = SimplexMCP.serveSSE("/sse", { binding: "MCP_OBJECT" });

const LANDING_HTML = `<!doctype html>
<meta charset="utf-8">
<title>simplex-mcp</title>
<style>body{font-family:system-ui;margin:2rem;max-width:42rem;line-height:1.5}code{background:#f3f3f3;padding:.1em .3em;border-radius:.2em}</style>
<h1>simplex-mcp</h1>
<p>Remote MCP server for solving Linear Programming problems with the Simplex Method.</p>
<ul>
  <li>MCP Streamable HTTP endpoint: <code>/mcp</code></li>
  <li>MCP SSE endpoint (legacy): <code>/sse</code></li>
  <li>Tools: <code>parse_lp_text</code>, <code>solve_simplex_problem</code></li>
</ul>
<p>Add this URL as an MCP server in your client (Claude Desktop, Cursor, etc.).</p>
`;

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname.startsWith("/download/")) {
      return verifyAndStream(req, env);
    }

    const isMcp = url.pathname === "/mcp" || url.pathname.startsWith("/mcp/");
    const isSse = url.pathname === "/sse" || url.pathname.startsWith("/sse/");
    if (isMcp || isSse) {
      // Fail closed: if the secret was never set, refuse to serve. This prevents
      // a misconfigured deploy from silently exposing the MCP endpoint.
      if (!env.MCP_AUTH_TOKEN) {
        return new Response("server auth not configured", { status: 500 });
      }
      if (!checkBearer(req, env.MCP_AUTH_TOKEN)) {
        return new Response("unauthorized", { status: 401, headers: UNAUTHORIZED_HEADERS });
      }
      return (isMcp ? mcpHandler : sseHandler).fetch(normalizeMcpAccept(req), env, ctx);
    }

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(LANDING_HTML, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // OAuth-aware clients (Claude.ai's custom-connector login) probe
    // /.well-known/oauth-authorization-server, /.well-known/oauth-protected-resource,
    // etc. and JSON.parse the body of any non-2xx response as an RFC 6749 error.
    // A plain-text "not found" body crashes that parser with
    // `Unexpected identifier "not"`. Returning a JSON-shaped error lets the
    // client recognize "no OAuth here" cleanly instead of bubbling a parse error.
    return new Response(
      JSON.stringify({ error: "not_found", error_description: "not found" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  },
} satisfies ExportedHandler<Env>;
