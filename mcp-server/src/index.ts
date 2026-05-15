// Cloudflare Worker entry point for the Simplex MCP server.
//
// Wraps the MCP transport in an OAuth 2.1 provider so Claude.ai's
// "Add custom connector" login flow works end-to-end. Routes:
//
//   POST /mcp                                  — MCP Streamable HTTP (OAuth-gated)
//   GET  /sse                                  — MCP SSE transport (OAuth-gated, legacy)
//   GET  /authorize                            — login form (shared password)
//   POST /authorize                            — verify password + issue grant
//   POST /token                                — OAuth token exchange (provider-handled)
//   POST /register                             — RFC 7591 dynamic client registration
//   GET  /.well-known/oauth-authorization-server — RFC 8414 metadata (provider-handled)
//   GET  /.well-known/oauth-protected-resource — RFC 9728 metadata (provider-handled)
//   GET  /download/:key                        — HMAC-verified xlsx download (public)
//   GET  /                                     — landing page

import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { handleParse } from "./tools/parse";
import { handleSolve, type SolveEnv } from "./tools/solve";
import { problemSchema } from "./schemas/problem";
import { verifyAndStream } from "./storage/signing";

export interface Env extends SolveEnv {
  MCP_OBJECT: DurableObjectNamespace;
  OAUTH_KV: KVNamespace;
  // Injected by OAuthProvider into the default handler's env.
  OAUTH_PROVIDER: OAuthHelpers;
  // Shared password gating /authorize. Set via `wrangler secret put MCP_PASSWORD`.
  MCP_PASSWORD: string;
}

// Props attached to the issued access token. Reachable from inside the
// McpAgent via `this.props` (typed by the third generic parameter).
type Props = { userId: string };

// Constant-time string compare so a wrong password can't leak length/prefix
// info via response timing.
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

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

export class SimplexMCP extends McpAgent<Env, unknown, Props> {
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

// McpAgent.serve() / serveSSE() return ExportedHandler-shaped objects with a
// `fetch` method. We wrap each to apply the Accept-header normalization before
// the agents library's strict 406 check, while preserving the ctx (so the
// OAuthProvider's authenticated props flow through).
const mcpInner = SimplexMCP.serve("/mcp", { binding: "MCP_OBJECT" });
const sseInner = SimplexMCP.serveSSE("/sse", { binding: "MCP_OBJECT" });

// `ExportedHandlerWithFetch` from workers-oauth-provider requires `fetch` to
// be a present property (not optional), so we declare a fetch-only wrapper
// rather than the partial-by-default `ExportedHandler<Env>`.
type FetchHandler = { fetch: (req: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response> };

const mcpHandler: FetchHandler = {
  fetch(req, env, ctx) {
    return mcpInner.fetch!(normalizeMcpAccept(req), env, ctx);
  },
};
const sseHandler: FetchHandler = {
  fetch(req, env, ctx) {
    return sseInner.fetch!(normalizeMcpAccept(req), env, ctx);
  },
};

const LANDING_HTML = `<!doctype html>
<meta charset="utf-8">
<title>simplex-mcp</title>
<style>body{font-family:system-ui;margin:2rem;max-width:42rem;line-height:1.5}code{background:#f3f3f3;padding:.1em .3em;border-radius:.2em}</style>
<h1>simplex-mcp</h1>
<p>Remote MCP server for solving Linear Programming problems with the Simplex Method.</p>
<ul>
  <li>MCP Streamable HTTP endpoint: <code>/mcp</code></li>
  <li>MCP SSE endpoint (legacy): <code>/sse</code></li>
  <li>OAuth metadata: <code>/.well-known/oauth-authorization-server</code></li>
  <li>Tools: <code>parse_lp_text</code>, <code>solve_simplex_problem</code></li>
</ul>
<p>Add this URL as an MCP server in your client (Claude.ai, Claude Desktop, Cursor, etc.).</p>
`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!),
  );
}

function loginPage(actionUrl: string, clientName: string | null, error: string | null): string {
  const safeAction = escapeHtml(actionUrl);
  const safeClient = clientName ? escapeHtml(clientName) : "an MCP client";
  const errBlock = error
    ? `<p style="color:#c0392b;margin:0 0 1rem 0">${escapeHtml(error)}</p>`
    : "";
  return `<!doctype html>
<meta charset="utf-8">
<title>Authorize · simplex-mcp</title>
<style>
  body{font-family:system-ui;margin:0;display:grid;place-items:center;min-height:100vh;background:#f7f7f8}
  form{background:#fff;padding:2rem;border-radius:.6rem;box-shadow:0 1px 3px rgba(0,0,0,.08);min-width:20rem}
  h1{font-size:1.1rem;margin:0 0 .25rem 0}
  p.lede{color:#555;margin:0 0 1rem 0;font-size:.9rem}
  input{display:block;width:100%;padding:.6rem;font-size:1rem;border:1px solid #ddd;border-radius:.35rem;box-sizing:border-box;margin-bottom:.75rem}
  button{padding:.6rem 1rem;font-size:1rem;background:#111;color:#fff;border:0;border-radius:.35rem;cursor:pointer;width:100%}
  button:hover{background:#000}
</style>
<form action="${safeAction}" method="POST">
  <h1>simplex-mcp</h1>
  <p class="lede">Authorize ${safeClient} to access this server.</p>
  ${errBlock}
  <input name="password" type="password" placeholder="Server password" autofocus autocomplete="current-password">
  <button type="submit">Authorize</button>
</form>
`;
}

const defaultHandler: ExportedHandler<Env> = {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname.startsWith("/download/")) {
      return verifyAndStream(req, env);
    }

    if (url.pathname === "/authorize") {
      if (!env.MCP_PASSWORD) {
        return new Response("server auth not configured", { status: 500 });
      }

      // parseAuthRequest reads OAuth params from the URL query string, so the
      // form's `action` must include `url.search` to round-trip them on POST.
      const actionUrl = url.pathname + url.search;

      let oauthReqInfo;
      try {
        oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(req);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "invalid request";
        return new Response(`Invalid authorization request: ${msg}`, { status: 400 });
      }

      const clientInfo = await env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
      const clientName = clientInfo?.clientName ?? null;

      if (req.method === "GET") {
        return new Response(loginPage(actionUrl, clientName, null), {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      if (req.method === "POST") {
        const form = await req.formData();
        const submitted = String(form.get("password") ?? "");
        if (!constantTimeEquals(submitted, env.MCP_PASSWORD)) {
          return new Response(loginPage(actionUrl, clientName, "Incorrect password."), {
            status: 401,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
          request: oauthReqInfo,
          userId: "simplex-user",
          metadata: { label: "simplex-mcp", client: clientName ?? oauthReqInfo.clientId },
          scope: oauthReqInfo.scope,
          props: { userId: "simplex-user" } satisfies Props,
        });
        return Response.redirect(redirectTo, 302);
      }
      return new Response("method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
    }

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(LANDING_HTML, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // JSON 404 so any OAuth-aware client that strays here gets a parseable
    // RFC 6749-shaped error instead of crashing on plain text.
    return new Response(
      JSON.stringify({ error: "not_found", error_description: "not found" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  },
};

const oauthProvider = new OAuthProvider({
  apiHandlers: {
    "/mcp": mcpHandler,
    "/sse": sseHandler,
  },
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    return oauthProvider.fetch(req, env, ctx);
  },
  // Hourly cron (see wrangler.jsonc `triggers.crons`). Evicts orphaned and
  // expired OAuth records from KV. Safe to call repeatedly — already-deleted
  // records disappear, so subsequent runs only walk fresh state.
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    const result = await oauthProvider.purgeExpiredData(env, {
      purgeOrphanedGrants: true,
      purgeExpiredGrants: true,
      purgeOrphanedTokens: true,
    });
    console.log(
      `oauth purge: grants ${result.grantsPurged}/${result.grantsChecked}, ` +
        `tokens ${result.tokensPurged}/${result.tokensChecked}, done=${result.done}`,
    );
  },
} satisfies ExportedHandler<Env>;
