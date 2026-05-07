// Step-by-step solution payload returned inside the MCP `text` content block.

export interface TableauJson {
  columns: string[];
  basic: string[];                  // basic variable name per row
  body: string[][];                 // exact rationals as strings
  rhs: string[];
  zj: string[];
  cj_minus_zj: string[];
  z: string;
  ratios: (string | null)[];
}

export interface StepJson {
  title: string;
  pivot: {
    row: number;
    col: number;
    var_in: string;
    var_out: string;
  } | null;
  row_operations: string[];
  tableau: TableauJson;
}

// One row in a model formulation (general or standard).
export interface ModelConstraintJson {
  name?: string;
  expression: string;               // e.g. "X1 + 2·X2"
  sign: "<=" | "=" | ">=";
  rhs: string;                      // exact rational as string
}

// Compact textual rendering of an LP, suitable for display side-by-side with
// the tableau steps. `general` is the user's original formulation; `standard`
// is the simplex-ready form (slack/surplus/artificial variables added,
// everything as equalities).
export interface ModelJson {
  objective: "max" | "min";
  variables: string[];              // technical names ("X1", "S1", "A2", ...)
  objective_expression: string;     // e.g. "3000·X1 + 2000·X2"
  constraints: ModelConstraintJson[];
  non_negativity: string;           // e.g. "X1, X2 ≥ 0" or "Xi, Si, Ai ≥ 0"
}

export interface SolveResultJson {
  status: "optimal" | "unbounded" | "infeasible";
  objective_value: string;
  variables: Record<string, string>;
  iterations: number;
  general_model: ModelJson;
  standard_model: ModelJson;
  steps: StepJson[];
  xlsx_url?: string;
  xlsx_expires_at?: string;
  xlsx_base64?: string;
  // Open index signature so this is assignable to the MCP SDK's
  // `structuredContent` field, which expects `{ [k: string]: unknown }`.
  [k: string]: unknown;
}
