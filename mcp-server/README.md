# simplex-mcp

A remote **Model Context Protocol** server, deployed on **Cloudflare Workers**, that
solves Linear Programming problems with the **Simplex Method** (Big-M when
artificial variables are needed) and returns:

- a step-by-step JSON solution (every tableau, pivot row/column/element,
  `Cj`, `Zj`, `Cj-Zj`, ratios, row operations, final solution), **and**
- a fully formatted `.xlsx` (matching the pedagogical Spanish layout from the
  sibling `main.py`) delivered as an HMAC-signed download URL.

## Tools exposed

| Tool                    | Input                                                                 | Output                                                                                  |
|-------------------------|-----------------------------------------------------------------------|-----------------------------------------------------------------------------------------|
| `parse_lp_text`         | `{ text: string }` — free-form NL ("maximize Z = 3x + 2y s.t. …")    | Structured `Problem` JSON ready for `solve_simplex_problem`                             |
| `solve_simplex_problem` | Structured LP (`objective`, `variables`, `objective_coefficients`, `constraints`, optional `delivery: "url" \| "inline"`) | JSON `SolveResult` + a downloadable `.xlsx` (signed URL by default; base64 if requested) |

The two tools are composable: an LLM can call `parse_lp_text` first, inspect the
JSON, and then call `solve_simplex_problem` — or skip the parser entirely when
it already has structured input.

## Project layout

```
mcp-server/
├── src/
│   ├── index.ts             # McpAgent + Worker fetch handler (/mcp, /sse, /download)
│   ├── lp/                  # solver port of main.py
│   │   ├── fraction.ts      #   exact rationals (BigInt-backed)
│   │   ├── bigm.ts          #   c + m·M arithmetic
│   │   ├── format.ts        #   pretty-printing
│   │   ├── problem.ts       #   load + validate
│   │   ├── standardize.ts   #   Tabla Resumen → StandardForm
│   │   ├── simplex.ts       #   iterator + snapshots
│   │   └── nlp.ts           #   natural-language parser
│   ├── excel/writer.ts      # xlsx-js-style writer
│   ├── storage/
│   │   ├── r2.ts            # R2 putXlsx, key generator
│   │   └── signing.ts       # HMAC-SHA256 signed download URLs
│   ├── schemas/             # Zod schemas
│   └── tools/               # MCP tool handlers
├── tests/                   # vitest: parity + NLP + fraction
├── wrangler.jsonc
├── package.json
└── tsconfig.json
```

## Local development

```bash
# from mcp-server/
npm install
echo "SIGNING_SECRET=dev-secret-change-me" > .dev.vars   # for local wrangler
npx wrangler dev
```

Open <http://localhost:8787> for the landing page, then point the
[MCP Inspector](https://github.com/modelcontextprotocol/inspector) at
`http://localhost:8787/mcp` to list and call tools interactively.

Run tests against the reference problems:

```bash
npm test
```

The parity suite loads `../problem1.json`, `../problem2.json`, `../problem3.json`
and asserts the TypeScript solver produces the same Z and basic-variable values
that `main.py` produces in `output1.xlsx` / `output2.xlsx` / `output3.xlsx`.

## Cloudflare deployment

Once-per-account setup:

```bash
npx wrangler r2 bucket create simplex-xlsx
npx wrangler secret put SIGNING_SECRET    # paste any 32+ char random string
```

Deploy:

```bash
npx wrangler deploy
```

Wrangler prints the deployed URL (e.g. `https://simplex-mcp.<account>.workers.dev`).
Add `<that URL>/mcp` as a remote MCP server in your client.

### What gets deployed

`wrangler.jsonc` declares:

- a Durable Object binding `MCP_OBJECT` → class `SimplexMCP` (per-session state
  for the `McpAgent`),
- an R2 bucket binding `XLSX_BUCKET` → `simplex-xlsx` (xlsx persistence),
- the `nodejs_compat` flag (Web Crypto + `node:buffer` interop),
- a SQLite migration (`v1`) for the Durable Object class.

`SIGNING_SECRET` is a Worker secret used only for HMAC-signing the
`/download/<key>?exp=<ts>&sig=<mac>` URLs; rotating it invalidates all
outstanding download links.

## Worked example

Natural-language request to the LLM:

> "Solve: maximize Z = 3000 x1 + 2000 x2 subject to x1 + 2 x2 <= 6,
> 2 x1 + x2 <= 8, -x1 + x2 <= 1, x2 <= 2, x1, x2 >= 0."

The model calls `parse_lp_text` (returning structured JSON), then
`solve_simplex_problem`, which returns:

```json
{
  "status": "optimal",
  "objective_value": "12666 2/3",
  "variables": { "X1": "3 1/3", "X2": "1 1/3", "S1": "0", "S2": "0", "S3": "2 2/3", "S4": "2/3" },
  "iterations": 3,
  "steps": [ /* one entry per tableau, including Cj / Zj / Cj-Zj / pivot / row operations */ ],
  "xlsx_url": "https://simplex-mcp.<account>.workers.dev/download/<key>?exp=…&sig=…",
  "xlsx_expires_at": "2026-04-30T19:21:34.000Z"
}
```

Plus a `resource` content block pointing at the same URL, so MCP clients that
support the `resource` type render a one-click download.

## Special cases

The solver detects and reports both edge cases:

- **Unbounded** — entering column has no positive entries → status
  `unbounded`, last snapshot includes the offending pivot column.
- **Infeasible** — at least one artificial variable remained basic with a
  positive RHS at termination → status `infeasible`.

Both are surfaced in the JSON result and the final block of the `.xlsx`.

## Out of scope (v1)

- Auth (OAuth / API key) — server is authless.
- Two-phase method, sensitivity analysis, dual values — the Python reference
  is Big-M only; this port matches that for v1.
- LaTeX rendering of the steps — the JSON `steps[]` and the `.xlsx` already
  carry the full trace; client-side rendering is not the server's job.
