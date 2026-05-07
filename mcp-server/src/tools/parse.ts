// MCP tool: `parse_lp_text` — natural language → structured Problem JSON.

import { parseLpText } from "../lp/nlp";

export interface ParseHandlerResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  // Open index signature so the result is assignable to the MCP SDK's
  // CallToolResult shape, which carries arbitrary `_meta`/extension fields.
  [k: string]: unknown;
}

export async function handleParse(text: string): Promise<ParseHandlerResult> {
  try {
    const problem = parseLpText(text);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(problem, null, 2),
        },
      ],
    };
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    return {
      content: [
        {
          type: "text",
          text: `Could not parse: ${msg}\n\nExpected something like: "maximize Z = 3x + 2y subject to x + 2y <= 6, 2x + y <= 8, x, y >= 0".`,
        },
      ],
      isError: true,
    };
  }
}
