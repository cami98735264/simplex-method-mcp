import { describe, expect, it } from "vitest";
import { parseLpText } from "../src/lp/nlp";
import { loadProblem } from "../src/lp/problem";
import { solve } from "../src/lp/simplex";
import { fmtBigM } from "../src/lp/format";

describe("parseLpText", () => {
  it("parses a classic English maximization", () => {
    const raw = parseLpText(
      "maximize Z = 3x + 2y subject to x + 2y <= 6, 2x + y <= 8, -x + y <= 1, y <= 2",
    );
    expect(raw.objective).toBe("max");
    expect(raw.variables).toEqual(["x", "y"]);
    expect(raw.objective_coefficients.length).toBe(2);
    expect(raw.constraints.length).toBe(4);
    expect(raw.constraints.every((c) => c.sign === "<=")).toBe(true);
  });

  it("parses Spanish 'minimizar … sujeto a' with unicode operators", () => {
    const raw = parseLpText(
      "minimizar 3x1 + 4x2 sujeto a 4x1 + 4x2 ≤ 16; 4x1 + 12x2 ≥ 24",
    );
    expect(raw.objective).toBe("min");
    expect(raw.variables).toEqual(["x1", "x2"]);
    expect(raw.constraints.map((c) => c.sign)).toEqual(["<=", ">="]);
  });

  it("round-trips Problema 1 from natural language to the same Z", () => {
    const raw = parseLpText(
      "maximize 3000 x1 + 2000 x2 subject to x1 + 2 x2 <= 6, 2 x1 + x2 <= 8, -x1 + x2 <= 1, x2 <= 2",
    );
    const p = loadProblem(raw);
    const out = solve(p);
    expect(out.status).toBe("optimal");
    expect(fmtBigM(out.zValue)).toBe("12666 2/3");
  });

  it("rejects input missing an objective verb", () => {
    expect(() => parseLpText("3x + 2y subject to x + y <= 4")).toThrow();
  });
});
