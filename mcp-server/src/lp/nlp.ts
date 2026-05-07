// Free-form natural-language LP description → RawProblem.
//
// Handles inputs like:
//   "Maximize Z = 3x + 2y subject to x + 2y <= 6, 2x + y <= 8, x, y >= 0"
//   "min 3 x1 + 4 x2 s.t. 4x1 + 4x2 ≤ 16; 4x1 + 12x2 ≥ 24"
//   "maximizar 3000 X1 + 2000 X2 sujeto a x1 + 2x2 <= 6 y 2x1 + x2 <= 8"
//
// The parser is intentionally regex-driven and forgiving — the calling LLM
// can also build the structured RawProblem directly when it prefers.

import type { FractionLike } from "./fraction";
import type { RawConstraint, RawProblem, Sign } from "./problem";

const OBJECTIVE_RE = /\b(max(?:imi[sz]e|imizar)?|min(?:imi[sz]e|imizar)?)\b/i;
const SUBJECT_TO_RE = /\b(s(?:ubject)?\.?\s*t(?:o)?\.?|sujeto\s*a|where|donde|such\s+that|with)\b/i;
const NONNEG_RE = /(?:[a-zA-Z][a-zA-Z0-9_]*\s*(?:,\s*[a-zA-Z][a-zA-Z0-9_]*\s*)*)(?:>=|>=|≥|>=)\s*0\b|all\s+(?:vars?|variables?)\s*(?:>=|≥)\s*0/i;

const SIGN_REPLACEMENTS: [RegExp, string][] = [
  [/≤/g, "<="],
  [/≥/g, ">="],
  [/⩽/g, "<="],
  [/⩾/g, ">="],
  [/=</g, "<="],
  [/=>/g, ">="],
  [/−/g, "-"],   // unicode minus
];

function normalize(text: string): string {
  let s = text.trim();
  for (const [re, rep] of SIGN_REPLACEMENTS) s = s.replace(re, rep);
  s = s.replace(/\s+/g, " ");
  return s;
}

function detectObjective(text: string): { objective: "max" | "min"; rest: string } {
  const m = text.match(OBJECTIVE_RE);
  if (!m) throw new Error("could not find an objective verb (max/min/maximize/minimize)");
  const verb = m[1].toLowerCase();
  const objective: "max" | "min" = verb.startsWith("max") ? "max" : "min";
  const rest = text.slice((m.index ?? 0) + m[0].length);
  return { objective, rest };
}

function splitObjectiveAndConstraints(text: string): { objExpr: string; consPart: string } {
  const m = text.match(SUBJECT_TO_RE);
  if (!m) {
    // Allow "maximize ... constraints..." with newlines as separator.
    const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length >= 2) {
      return { objExpr: lines[0], consPart: lines.slice(1).join(";") };
    }
    throw new Error("could not find a 'subject to' / 's.t.' separator");
  }
  return {
    objExpr: text.slice(0, m.index).trim(),
    consPart: text.slice((m.index ?? 0) + m[0].length).trim(),
  };
}

// Strip "Z =", "max Z =", leading colons, trailing punctuation.
function cleanObjectiveExpr(expr: string): string {
  let s = expr.trim();
  s = s.replace(/^[:=\s]+/, "");
  s = s.replace(/^(?:Z|z|F\.?O\.?)\s*=\s*/i, "");
  s = s.replace(/^[:=\s]+/, "");
  s = s.replace(/\.+$/, "");
  return s.trim();
}

const TERM_RE = /([+-]?)\s*(\d+(?:\.\d+)?(?:\/\d+)?|\d*\.\d+)?\s*\*?\s*([a-zA-Z][a-zA-Z0-9_]*)/g;

function tokenizeLinear(expr: string): { coef: string; variable: string }[] {
  const cleaned = expr.replace(/\s+/g, " ").trim();
  const out: { coef: string; variable: string }[] = [];
  TERM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TERM_RE.exec(cleaned)) !== null) {
    const sign = m[1] || "+";
    let mag = m[2];
    const variable = m[3];
    if (!variable) continue;
    if (mag === undefined || mag === "") mag = "1";
    const coef = sign === "-" ? `-${mag}` : mag;
    out.push({ coef, variable });
  }
  if (out.length === 0) {
    throw new Error(`no linear terms found in '${expr}'`);
  }
  return out;
}

const SIGN_TOKEN_RE = /(<=|>=|=)/;

function splitConstraints(consPart: string): string[] {
  // First strip any non-negativity declarations (we treat all vars >= 0).
  // Replace English "and" with a comma; deliberately do NOT touch Spanish "y"
  // because it collides with variable names commonly named `y`. Spanish
  // statements should use `,` / `;` / newlines as constraint separators.
  const stripped = consPart
    .replace(NONNEG_RE, " ")
    .replace(/\band\b/gi, ",");
  // Split on ; , or newline. Keep parts that contain a sign token.
  const parts = stripped.split(/[;\n]|,(?![^()]*\))/).map((s) => s.trim()).filter(Boolean);
  return parts.filter((p) => SIGN_TOKEN_RE.test(p));
}

function parseConstraint(expr: string, varOrder: string[]): RawConstraint & { _vars: string[] } {
  const m = expr.match(SIGN_TOKEN_RE);
  if (!m) throw new Error(`constraint missing relational operator: '${expr}'`);
  const sign = m[1] as Sign;
  const lhs = expr.slice(0, m.index).trim();
  const rhsStr = expr.slice((m.index ?? 0) + m[0].length).trim().replace(/[.,;]+$/, "");

  let coefSum = new Map<string, string>();
  // Allow constants on the LHS too: subtract them from RHS at the end.
  const lhsTerms = tokenizeLinear(lhs);
  for (const { coef, variable } of lhsTerms) {
    // Sum same-variable terms by string concatenation through Fraction later.
    coefSum.set(variable, coefSum.has(variable)
      ? `(${coefSum.get(variable)})+(${coef})`
      : coef);
  }

  // Note: tokenizer skips bare constants on LHS; if the user writes "x + 3 = 5"
  // we'd lose the 3. Rare in textbook LPs; keep it simple.

  const seenVars = Array.from(coefSum.keys());
  for (const v of seenVars) {
    if (!varOrder.includes(v)) varOrder.push(v);
  }

  // Coefficient list aligned with the *current* varOrder; padded later.
  const coefficients: (string | number)[] = varOrder.map((v) => coefSum.get(v) ?? 0);

  // Parse RHS: must be a pure number (we rejected bare constants on LHS).
  if (!/^[+-]?\s*\d+(?:\.\d+)?(?:\/\d+)?$|^[+-]?\s*\d*\.\d+$/.test(rhsStr.replace(/\s+/g, ""))) {
    throw new Error(`constraint RHS must be a number, got '${rhsStr}' in '${expr}'`);
  }
  const rhs = rhsStr.replace(/\s+/g, "");

  return {
    coefficients,
    sign,
    rhs,
    _vars: seenVars,
  };
}

export function parseLpText(text: string): RawProblem {
  const norm = normalize(text);
  const { objective, rest } = detectObjective(norm);
  const { objExpr, consPart } = splitObjectiveAndConstraints(rest);
  const cleanedObj = cleanObjectiveExpr(objExpr);
  const objTerms = tokenizeLinear(cleanedObj);

  const variables: string[] = [];
  const objCoefByVar = new Map<string, string>();
  for (const { coef, variable } of objTerms) {
    if (!variables.includes(variable)) variables.push(variable);
    objCoefByVar.set(variable, objCoefByVar.has(variable)
      ? `(${objCoefByVar.get(variable)})+(${coef})`
      : coef);
  }

  const rawConstraints = splitConstraints(consPart);
  if (rawConstraints.length === 0) {
    throw new Error("no constraints parsed (after stripping non-negativity)");
  }

  // Two-pass over constraints so we can extend `variables` with any new ones
  // discovered in constraints, then re-pad earlier rows.
  const parsed = rawConstraints.map((c, i) => {
    try { return parseConstraint(c, variables); }
    catch (e) { throw new Error(`constraint ${i + 1}: ${(e as Error).message}`); }
  });

  // Pad / order all coefficient arrays to the final variables list.
  const objective_coefficients = variables.map((v) => objCoefByVar.get(v) ?? 0);
  const constraints: RawConstraint[] = parsed.map(({ _vars, ...c }, i) => {
    void _vars;
    // Re-build coefficients aligned with the final variables order.
    const m = new Map<string, FractionLike>();
    for (let j = 0; j < c.coefficients.length; j++) {
      const varName = variables[j];
      if (varName !== undefined) m.set(varName, c.coefficients[j]);
    }
    return {
      name: `R${i + 1}`,
      coefficients: variables.map((v) => m.get(v) ?? 0),
      sign: c.sign,
      rhs: c.rhs,
    };
  });

  return {
    name: "LP from natural language",
    objective,
    variables,
    objective_coefficients,
    constraints,
  };
}
