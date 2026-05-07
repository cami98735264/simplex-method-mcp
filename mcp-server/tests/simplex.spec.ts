import { describe, expect, it } from "vitest";
import { loadProblem } from "../src/lp/problem";
import { solve } from "../src/lp/simplex";
import { fmtBigM, fmtFraction } from "../src/lp/format";

import problem1 from "../../problem1.json";
import problem2 from "../../problem2.json";
import problem3 from "../../problem3.json";

describe("Simplex parity vs main.py reference outputs", () => {
  it("Problema 1 — Reddy Miks (max, 4 ≤ constraints) → Z = 12666 2/3", () => {
    const p = loadProblem(problem1 as never);
    const out = solve(p);
    expect(out.status).toBe("optimal");
    expect(fmtBigM(out.zValue)).toBe("12666 2/3");

    const values: Record<string, string> = {};
    for (let i = 0; i < out.finalBasic.length; i++) {
      values[out.sf.columnLabels[out.finalBasic[i]]] = fmtFraction(out.finalRhs[i]);
    }
    expect(values["X1"]).toBe("3 1/3");   // 10/3
    expect(values["X2"]).toBe("1 1/3");   // 4/3
  });

  it("Problema 2 — Compañía de Combustibles (min, mixed ≤ and ≥) → Z = 8", () => {
    const p = loadProblem(problem2 as never);
    const out = solve(p);
    expect(out.status).toBe("optimal");
    expect(fmtBigM(out.zValue)).toBe("8");

    const values: Record<string, string> = {};
    for (let i = 0; i < out.finalBasic.length; i++) {
      values[out.sf.columnLabels[out.finalBasic[i]]] = fmtFraction(out.finalRhs[i]);
    }
    expect(values["X2"]).toBe("2");
    expect(values["S1"]).toBe("8");
  });

  it("Problema 3 — Fábrica de congeladores (max, 5 constraints with one ≥) is feasible", () => {
    const p = loadProblem(problem3 as never);
    const out = solve(p);
    expect(out.status).toBe("optimal");
    // Just sanity-check that the solver terminated and Z is finite.
    expect(out.zValue.m.isZero()).toBe(true);
  });
});
