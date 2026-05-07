// LP → simplex-ready Tabla Resumen. Port of main.py §4.

import { Fraction } from "./fraction";
import { BigM } from "./bigm";
import type { Problem } from "./problem";

export interface StandardForm {
  columnLabels: string[];
  cj: BigM[];
  body: Fraction[][];
  rhs: Fraction[];
  basic: number[];
  artificialCols: Set<number>;
}

export function standardize(problem: Problem): StandardForm {
  const isMax = problem.objective === "max";
  const bigMSign = isMax ? -1n : 1n;
  const nCons = problem.constraints.length;

  const columnLabels: string[] = [...problem.variables];
  const cj: BigM[] = problem.objectiveCoefficients.map((c) => new BigM(c, 0n));

  const body: Fraction[][] = problem.constraints.map((c) => [...c.coefficients]);
  const rhs: Fraction[] = problem.constraints.map((c) => c.rhs);
  const basic: number[] = Array(nCons).fill(-1);
  const artificialCols = new Set<number>();

  const addColumn = (label: string, cjValue: BigM, entries: Map<number, Fraction>): number => {
    columnLabels.push(label);
    cj.push(cjValue);
    const colPos = columnLabels.length - 1;
    for (let r = 0; r < nCons; r++) {
      body[r].push(entries.get(r) ?? Fraction.ZERO);
    }
    return colPos;
  };

  problem.constraints.forEach((con, r) => {
    const rowLabel = r + 1;
    if (con.sign === "<=") {
      const col = addColumn(`S${rowLabel}`, BigM.ZERO, new Map([[r, Fraction.ONE]]));
      basic[r] = col;
    } else if (con.sign === "=") {
      const col = addColumn(`A${rowLabel}`, new BigM(0n, bigMSign), new Map([[r, Fraction.ONE]]));
      basic[r] = col;
      artificialCols.add(col);
    } else { // ">="
      addColumn(`S${rowLabel}`, BigM.ZERO, new Map([[r, Fraction.NEG_ONE]]));
      const col = addColumn(`A${rowLabel}`, new BigM(0n, bigMSign), new Map([[r, Fraction.ONE]]));
      basic[r] = col;
      artificialCols.add(col);
    }
  });

  return { columnLabels, cj, body, rhs, basic, artificialCols };
}
