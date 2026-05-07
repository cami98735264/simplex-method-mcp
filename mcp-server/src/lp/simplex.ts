// Simplex iterator. Port of main.py §5–6.

import { Fraction } from "./fraction";
import { BigM } from "./bigm";
import { fmtFraction } from "./format";
import type { Problem } from "./problem";
import { standardize, type StandardForm } from "./standardize";

export type SimplexStatus = "optimal" | "unbounded" | "infeasible";

export interface Snapshot {
  title: string;
  columnLabels: string[];
  cj: BigM[];
  basic: number[];
  body: Fraction[][];
  rhs: Fraction[];
  zj: BigM[];
  cjMinusZj: BigM[];
  zValue: BigM;
  ratios: (Fraction | null)[];
  pivotRow: number | null;
  pivotCol: number | null;
  rowOps: string[];
}

export interface SolveOutcome {
  status: SimplexStatus;
  snapshots: Snapshot[];
  sf: StandardForm;
  problem: Problem;
  finalBasic: number[];
  finalBody: Fraction[][];
  finalRhs: Fraction[];
  zValue: BigM;
}

function zjRow(basic: number[], cj: BigM[], body: Fraction[][]): BigM[] {
  const nCols = cj.length;
  const zj: BigM[] = Array(nCols).fill(null).map(() => BigM.ZERO);
  for (let r = 0; r < basic.length; r++) {
    const cb = cj[basic[r]];
    for (let j = 0; j < nCols; j++) {
      zj[j] = zj[j].add(cb.mul(body[r][j]));
    }
  }
  return zj;
}

function zValueOf(basic: number[], cj: BigM[], rhs: Fraction[]): BigM {
  let z = BigM.ZERO;
  for (let r = 0; r < basic.length; r++) {
    z = z.add(cj[basic[r]].mul(rhs[r]));
  }
  return z;
}

export function solve(problem: Problem): SolveOutcome {
  const sf = standardize(problem);
  const isMax = problem.objective === "max";

  // Working state — deep-copied between snapshots.
  let body: Fraction[][] = sf.body.map((row) => [...row]);
  let rhs: Fraction[] = [...sf.rhs];
  let basic: number[] = [...sf.basic];
  const cj = sf.cj;
  const snapshots: Snapshot[] = [];

  let iteration = 0;
  let rowOps: string[] = Array(basic.length).fill("");

  while (true) {
    const zj = zjRow(basic, cj, body);
    const cjZj = cj.map((c, j) => c.sub(zj[j]));
    const zVal = zValueOf(basic, cj, rhs);

    let optimal: boolean;
    let bestIdx: number;
    let bestImproving: boolean;

    if (isMax) {
      optimal = cjZj.every((v) => v.le(0n));
      bestIdx = 0;
      for (let j = 1; j < cjZj.length; j++) {
        if (cjZj[j].gt(cjZj[bestIdx])) bestIdx = j;
      }
      bestImproving = cjZj[bestIdx].gt(0n);
    } else {
      optimal = cjZj.every((v) => v.ge(0n));
      bestIdx = 0;
      for (let j = 1; j < cjZj.length; j++) {
        if (cjZj[j].lt(cjZj[bestIdx])) bestIdx = j;
      }
      bestImproving = cjZj[bestIdx].lt(0n);
    }

    if (optimal || !bestImproving) {
      snapshots.push({
        title: `Iteración ${iteration} (óptima)`,
        columnLabels: [...sf.columnLabels],
        cj: [...cj],
        basic: [...basic],
        body: body.map((r) => [...r]),
        rhs: [...rhs],
        zj,
        cjMinusZj: cjZj,
        zValue: zVal,
        ratios: Array(basic.length).fill(null),
        pivotRow: null,
        pivotCol: null,
        rowOps: [...rowOps],
      });
      // Infeasibility: any artificial still basic with nonzero RHS?
      for (let r = 0; r < basic.length; r++) {
        if (sf.artificialCols.has(basic[r]) && !rhs[r].isZero()) {
          return {
            status: "infeasible",
            snapshots, sf, problem,
            finalBasic: basic, finalBody: body, finalRhs: rhs, zValue: zVal,
          };
        }
      }
      return {
        status: "optimal",
        snapshots, sf, problem,
        finalBasic: basic, finalBody: body, finalRhs: rhs, zValue: zVal,
      };
    }

    const pivotCol = bestIdx;

    // Min-ratio test (positive entries only).
    const ratios: (Fraction | null)[] = [];
    let bestRow = -1;
    let bestRatio: Fraction | null = null;
    for (let r = 0; r < basic.length; r++) {
      const entry = body[r][pivotCol];
      if (entry.gt(0n)) {
        const ratio = rhs[r].div(entry);
        ratios.push(ratio);
        const isBetter = bestRatio === null || ratio.lt(bestRatio) ||
          (ratio.eq(bestRatio) && bestRow >= 0 && basic[r] < basic[bestRow]);  // Bland's rule
        if (isBetter) {
          bestRatio = ratio;
          bestRow = r;
        }
      } else {
        ratios.push(null);
      }
    }

    if (bestRow < 0) {
      snapshots.push({
        title: `Iteración ${iteration} (no acotado)`,
        columnLabels: [...sf.columnLabels],
        cj: [...cj],
        basic: [...basic],
        body: body.map((r) => [...r]),
        rhs: [...rhs],
        zj,
        cjMinusZj: cjZj,
        zValue: zVal,
        ratios,
        pivotRow: null,
        pivotCol,
        rowOps: [...rowOps],
      });
      return {
        status: "unbounded",
        snapshots, sf, problem,
        finalBasic: basic, finalBody: body, finalRhs: rhs, zValue: zVal,
      };
    }

    // Snapshot BEFORE the pivot — matches the PDF tableau layout.
    snapshots.push({
      title: `Iteración ${iteration}`,
      columnLabels: [...sf.columnLabels],
      cj: [...cj],
      basic: [...basic],
      body: body.map((r) => [...r]),
      rhs: [...rhs],
      zj,
      cjMinusZj: cjZj,
      zValue: zVal,
      ratios,
      pivotRow: bestRow,
      pivotCol,
      rowOps: [...rowOps],
    });

    // Pivot.
    const pivotVal = body[bestRow][pivotCol];
    const newPivotRow = body[bestRow].map((v) => v.div(pivotVal));
    const newPivotRhs = rhs[bestRow].div(pivotVal);
    // Row-operation labels in Gauss-Jordan "Fᵢ ← <expr>" form, so each cell
    // explicitly states what the new row is. Unchanged rows are left blank.
    const newRowOps: string[] = Array(basic.length).fill("");
    const Fp = `F${bestRow + 1}`;
    if (!pivotVal.eq(1n)) {
      // Scale pivot row: F<p> ← (1/pivot)·F<p>
      newRowOps[bestRow] = `${Fp} ← (${fmtFraction(Fraction.ONE.div(pivotVal))})·${Fp}`;
    }

    const newBody = body.map((r) => [...r]);
    const newRhs = [...rhs];
    newBody[bestRow] = newPivotRow;
    newRhs[bestRow] = newPivotRhs;

    for (let r = 0; r < basic.length; r++) {
      if (r === bestRow) continue;
      const factor = body[r][pivotCol];
      const Fr = `F${r + 1}`;
      if (factor.isZero()) {
        newRowOps[r] = "";   // row unchanged
        continue;
      }
      newBody[r] = body[r].map((v, j) => v.sub(factor.mul(newPivotRow[j])));
      newRhs[r] = rhs[r].sub(factor.mul(newPivotRhs));
      // new_r = old_r − factor·new_pivot   ⇒   F<r> ← F<r> − (factor)·F<p>
      // Negative factor flips the sign so the user sees a clean "+" or "−".
      const isNeg = factor.lt(0n);
      const absFactor = isNeg ? factor.neg() : factor;
      const sign = isNeg ? "+" : "-";
      const term = absFactor.eq(1n) ? Fp : `(${fmtFraction(absFactor)})·${Fp}`;
      newRowOps[r] = `${Fr} ← ${Fr} ${sign} ${term}`;
    }

    body = newBody;
    rhs = newRhs;
    basic[bestRow] = pivotCol;
    rowOps = newRowOps;
    iteration++;
  }
}

export { standardize };
