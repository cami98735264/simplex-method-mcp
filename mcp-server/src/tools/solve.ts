// MCP tool: `solve_simplex_problem` — structured Problem → solution + xlsx URL.

import { fmtBigM, fmtFraction, formatLinearExpr, type LinearTerm } from "../lp/format";
import { loadProblem } from "../lp/problem";
import { solve, type Snapshot, type SolveOutcome } from "../lp/simplex";
import { writeXlsxBytes } from "../excel/writer";
import { newXlsxKey, putXlsx, type XlsxStoreEnv } from "../storage/r2";
import { signDownloadUrl, type SignEnv } from "../storage/signing";
import type { ProblemInput } from "../schemas/problem";
import type { ModelJson, SolveResultJson, StepJson } from "../schemas/solution";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

interface ResourceContent {
  type: "resource";
  resource: {
    uri: string;
    text: string;
    mimeType?: string;
  };
}

interface TextContent {
  type: "text";
  text: string;
}

export interface SolveHandlerResult {
  content: (TextContent | ResourceContent)[];
  isError?: boolean;
  // The MCP SDK's structured output channel — clients can consume the typed
  // SolveResultJson without re-parsing the `text` block.
  structuredContent?: SolveResultJson;
  // Open index signature — see parse.ts for rationale.
  [k: string]: unknown;
}

function snapshotToStep(snap: Snapshot): StepJson {
  const basicNames = snap.basic.map((idx) => snap.columnLabels[idx]);
  return {
    title: snap.title,
    pivot: snap.pivotRow !== null && snap.pivotCol !== null ? {
      row: snap.pivotRow,
      col: snap.pivotCol,
      var_in: snap.columnLabels[snap.pivotCol],
      var_out: snap.columnLabels[snap.basic[snap.pivotRow]],
    } : null,
    row_operations: [...snap.rowOps],
    tableau: {
      columns: [...snap.columnLabels],
      basic: basicNames,
      body: snap.body.map((row) => row.map((v) => fmtFraction(v))),
      rhs: snap.rhs.map((v) => fmtFraction(v)),
      zj: snap.zj.map((v) => fmtBigM(v)),
      cj_minus_zj: snap.cjMinusZj.map((v) => fmtBigM(v)),
      z: fmtBigM(snap.zValue),
      ratios: snap.ratios.map((r) => (r === null ? null : fmtFraction(r))),
    },
  };
}

function buildGeneralModel(outcome: SolveOutcome): ModelJson {
  const p = outcome.problem;
  const objTerms: LinearTerm[] = p.objectiveCoefficients.map((c, i) => [c, p.variables[i]]);
  const constraints = p.constraints.map((con) => {
    const terms: LinearTerm[] = con.coefficients.map((v, j) => [v, p.variables[j]]);
    return {
      name: con.name,
      expression: formatLinearExpr(terms, { keepZero: false }),
      sign: con.sign,
      rhs: fmtFraction(con.rhs),
    };
  });
  return {
    objective: p.objective,
    variables: [...p.variables],
    objective_expression: formatLinearExpr(objTerms, { keepZero: true }),
    constraints,
    non_negativity: `${p.variables.join(", ")} ≥ 0`,
  };
}

function buildStandardModel(outcome: SolveOutcome): ModelJson {
  const sf = outcome.sf;
  const objTerms: LinearTerm[] = sf.cj.map((c, i) => [c, sf.columnLabels[i]]);
  const constraints = sf.body.map((row, i) => {
    const terms: LinearTerm[] = row.map((v, j) => [v, sf.columnLabels[j]]);
    return {
      // Standard rows inherit their constraint name from the original problem
      // when available; otherwise fall back to "R<i>".
      name: outcome.problem.constraints[i]?.name,
      expression: formatLinearExpr(terms, { keepZero: false }),
      sign: "=" as const,
      rhs: fmtFraction(sf.rhs[i]),
    };
  });
  return {
    objective: outcome.problem.objective,
    variables: [...sf.columnLabels],
    objective_expression: formatLinearExpr(objTerms, { keepZero: true }),
    constraints,
    non_negativity: "Xi, Si, Ai ≥ 0",
  };
}

function buildResultJson(outcome: SolveOutcome): SolveResultJson {
  const steps = outcome.snapshots.map(snapshotToStep);

  // Variable-name → exact-string mapping (basic vars carry their RHS, others 0).
  const variables: Record<string, string> = {};
  if (outcome.status === "optimal") {
    for (const lbl of outcome.sf.columnLabels) variables[lbl] = "0";
    for (let i = 0; i < outcome.finalBasic.length; i++) {
      variables[outcome.sf.columnLabels[outcome.finalBasic[i]]] = fmtFraction(outcome.finalRhs[i]);
    }
  }

  return {
    status: outcome.status,
    objective_value: fmtBigM(outcome.zValue),
    variables,
    iterations: outcome.snapshots.length,
    general_model: buildGeneralModel(outcome),
    standard_model: buildStandardModel(outcome),
    steps,
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  // Chunked btoa to avoid OOM on large payloads.
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
  }
  return btoa(bin);
}

export type SolveEnv = XlsxStoreEnv & SignEnv;

export async function handleSolve(
  input: ProblemInput,
  env: SolveEnv,
  request: { url?: string } | undefined,
): Promise<SolveHandlerResult> {
  // 1. Validate + load. RawProblem accepts number | string coefficients directly.
  let outcome: SolveOutcome;
  try {
    const problem = loadProblem({
      name: input.name,
      objective: input.objective,
      variables: input.variables,
      objective_coefficients: input.objective_coefficients,
      variable_labels: input.variable_labels,
      constraints: input.constraints.map((c) => ({
        name: c.name,
        coefficients: c.coefficients,
        sign: c.sign,
        rhs: c.rhs,
      })),
    });
    outcome = solve(problem);
  } catch (e) {
    return {
      content: [{ type: "text", text: `Solver error: ${(e as Error).message ?? String(e)}` }],
      isError: true,
    };
  }

  // 2. Build the JSON result.
  const result: SolveResultJson = buildResultJson(outcome);

  // 3. Render xlsx.
  let xlsxBytes: Uint8Array;
  try {
    xlsxBytes = writeXlsxBytes(outcome);
  } catch (e) {
    return {
      content: [{ type: "text", text: `Excel generation failed: ${(e as Error).message ?? String(e)}` }],
      isError: true,
    };
  }

  // 4. Deliver xlsx according to delivery mode.
  const delivery = input.delivery ?? "url";
  const content: SolveHandlerResult["content"] = [];

  if (delivery === "url") {
    try {
      const key = newXlsxKey();
      await putXlsx(env, key, xlsxBytes);
      const origin = request?.url ? new URL(request.url).origin : "";
      const { url, expiresAt } = await signDownloadUrl(origin, key, 900, env);
      result.xlsx_url = url;
      result.xlsx_expires_at = expiresAt;
      content.push({ type: "text", text: JSON.stringify(result, null, 2) });
      content.push({
        type: "resource",
        resource: {
          uri: url,
          mimeType: XLSX_MIME,
          text: `Step-by-step Excel for "${outcome.problem.name}". Expires ${expiresAt}.`,
        },
      });
    } catch (e) {
      // Fallback: still return JSON without the URL so the caller has the
      // step-by-step solution even if storage failed.
      content.push({
        type: "text",
        text: `Solution computed, but xlsx upload failed: ${(e as Error).message}\n\n${JSON.stringify(result, null, 2)}`,
      });
      return { content, isError: true, structuredContent: result };
    }
  } else {
    result.xlsx_base64 = bytesToBase64(xlsxBytes);
    content.push({ type: "text", text: JSON.stringify(result, null, 2) });
  }

  return { content, structuredContent: result };
}
