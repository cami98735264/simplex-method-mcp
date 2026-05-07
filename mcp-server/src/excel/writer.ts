// XLSX writer mirroring main.py §7. Uses xlsx-js-style (a free community fork
// of SheetJS CE that adds full cell styling) so we can render pivot
// highlights, headers, and exact-fraction number formats.
//
// Output bytes are returned as a Uint8Array so the caller can stream them
// straight into R2 or base64-encode them for inline delivery.

import * as XLSX from "xlsx-js-style";
import { Fraction } from "../lp/fraction";
import { BigM } from "../lp/bigm";
import { fmtFraction, fmtBigM, formatLinearExpr, type LinearTerm } from "../lp/format";
import type { Snapshot, SolveOutcome } from "../lp/simplex";
import type { Problem } from "../lp/problem";
import type { StandardForm } from "../lp/standardize";

// ---- Style palette (matches main.py exactly) -------------------------------
type Fill = { fgColor: { rgb: string }; patternType: "solid" };
type Font = { bold?: boolean; sz?: number };
type Alignment = { horizontal: "left" | "center"; vertical: "center"; wrapText: boolean };

const FILL_HEADER:     Fill = { fgColor: { rgb: "F2F2F2" }, patternType: "solid" };
const FILL_PIVOT_COL:  Fill = { fgColor: { rgb: "F2F2F2" }, patternType: "solid" };
const FILL_PIVOT_ROW:  Fill = { fgColor: { rgb: "E7E6E6" }, patternType: "solid" };
const FILL_PIVOT_CELL: Fill = { fgColor: { rgb: "FFE699" }, patternType: "solid" };
const FILL_ZJ:         Fill = { fgColor: { rgb: "F2F2F2" }, patternType: "solid" };

const BORDER = {
  top:    { style: "thin", color: { rgb: "000000" } },
  bottom: { style: "thin", color: { rgb: "000000" } },
  left:   { style: "thin", color: { rgb: "000000" } },
  right:  { style: "thin", color: { rgb: "000000" } },
} as const;

const ALIGN_CENTER: Alignment = { horizontal: "center", vertical: "center", wrapText: false };
const ALIGN_LEFT:   Alignment = { horizontal: "left",   vertical: "center", wrapText: false };

const FONT_TITLE:    Font = { bold: true, sz: 12 };
const FONT_SUBTITLE: Font = { bold: true, sz: 11 };
const FONT_HEADER:   Font = { bold: true };
const FONT_BOLD:     Font = { bold: true };

// ---- Internal helpers ------------------------------------------------------

interface CellOpts {
  fill?: Fill;
  font?: Font;
  align?: Alignment;
  border?: boolean;
}

function buildStyle(opts: CellOpts) {
  const s: Record<string, unknown> = {};
  if (opts.fill) s.fill = opts.fill;
  if (opts.font) s.font = opts.font;
  s.alignment = opts.align ?? ALIGN_CENTER;
  if (opts.border !== false) s.border = BORDER;
  return s;
}

// Excel custom number format that displays a Fraction faithfully.
// integer       → "0"
// pure fraction → "??/??;-??/??;0;@"  (digit count matches the denominator)
// mixed         → "# ??/??;-# ??/??;0;@"
function fractionFormat(f: Fraction): string {
  if (f.isInteger()) return "0";
  const denomDigits = f.den.toString().length;
  const p = "?".repeat(Math.max(denomDigits, 1));
  const numAbs = f.num < 0n ? -f.num : f.num;
  if (numAbs < f.den) return `${p}/${p};-${p}/${p};0;@`;
  return `# ${p}/${p};-# ${p}/${p};0;@`;
}

interface SheetState {
  rows: Record<string, Record<string, unknown>>[];   // sparse, indexed cells
  merges: { s: { r: number; c: number }; e: { r: number; c: number } }[];
  displayWidths: Map<number, number>;                // col → max display chars
  maxCol: number;
}

function newState(): SheetState {
  return { rows: [], merges: [], displayWidths: new Map(), maxCol: 0 };
}

function recordWidth(state: SheetState, col: number, text: string | undefined): void {
  if (!text) return;
  const cur = state.displayWidths.get(col) ?? 0;
  if (text.length > cur) state.displayWidths.set(col, text.length);
}

function setText(
  state: SheetState,
  row: number,
  col: number,
  text: string,
  opts: CellOpts = {},
): void {
  if (!state.rows[row]) state.rows[row] = {};
  state.rows[row][String(col)] = {
    v: text,
    t: "s",
    s: buildStyle(opts),
  };
  recordWidth(state, col, text);
  if (col > state.maxCol) state.maxCol = col;
}

function setValue(
  state: SheetState,
  row: number,
  col: number,
  value: BigM | Fraction | number | string | null | undefined,
  opts: CellOpts = {},
): void {
  if (value === null || value === undefined) {
    setText(state, row, col, "", opts);
    return;
  }

  // BigM with M-term → text
  if (value instanceof BigM) {
    if (value.m.isZero()) {
      return setValue(state, row, col, value.c, opts);
    }
    setText(state, row, col, fmtBigM(value), opts);
    return;
  }

  if (value instanceof Fraction) {
    const display = fmtFraction(value);
    if (!state.rows[row]) state.rows[row] = {};
    if (value.isInteger()) {
      state.rows[row][String(col)] = {
        v: Number(value.num),
        t: "n",
        z: "0",
        s: buildStyle(opts),
      };
    } else {
      state.rows[row][String(col)] = {
        v: value.toNumber(),
        t: "n",
        z: fractionFormat(value),
        s: buildStyle(opts),
      };
    }
    recordWidth(state, col, display);
    if (col > state.maxCol) state.maxCol = col;
    return;
  }

  if (typeof value === "number") {
    if (!state.rows[row]) state.rows[row] = {};
    state.rows[row][String(col)] = {
      v: value,
      t: "n",
      s: buildStyle(opts),
    };
    recordWidth(state, col, String(value));
    if (col > state.maxCol) state.maxCol = col;
    return;
  }

  setText(state, row, col, String(value), opts);
}

function mergeRow(state: SheetState, row: number, fromCol: number, toCol: number): void {
  state.merges.push({
    s: { r: row, c: fromCol },
    e: { r: row, c: toCol },
  });
}

// ---- Display labels --------------------------------------------------------
// Build "technical name → human-friendly suffix" from user-provided variable
// labels (decision variables) and constraint names (slack/artificial vars).
// `displayLabel("xA")` → "xA (congelador A)" when a label is known, else "xA".

function buildDisplayLabels(problem: Problem, sf: StandardForm): string[] {
  const userLabels = problem.variableLabels ?? {};

  // Slack/artificial vars (Si / Ai) inherit the corresponding constraint's name.
  // Skip the auto-generated "R<i>" placeholder — it's not a useful label.
  const slackArtSuffix = new Map<string, string>();
  problem.constraints.forEach((c, i) => {
    const cname = c.name;
    if (!cname || /^R\d+$/.test(cname)) return;
    slackArtSuffix.set(`S${i + 1}`, cname);
    slackArtSuffix.set(`A${i + 1}`, cname);
  });

  return sf.columnLabels.map((lbl) => {
    const userLbl = userLabels[lbl];
    if (userLbl) return `${lbl} (${userLbl})`;
    const slackLbl = slackArtSuffix.get(lbl);
    if (slackLbl) return `${lbl} (${slackLbl})`;
    return lbl;
  });
}

// ---- Tableau / solution blocks --------------------------------------------

function writeTableau(
  state: SheetState,
  startRow: number,
  snap: Snapshot,
  displayLabels: string[],
): number {
  const nCols = snap.columnLabels.length;
  const VAR_START = 2;                  // 0-indexed col for first variable column
  const VAR_END = VAR_START + nCols - 1;
  const B_COL = VAR_END + 1;
  const RATIO_COL = B_COL + 1;
  const OP_COL = RATIO_COL + 1;

  let r = startRow;

  // Title
  setText(state, r, 0, snap.title, { font: FONT_SUBTITLE, align: ALIGN_LEFT, border: false });
  mergeRow(state, r, 0, OP_COL);
  r++;

  // Header line 1: Cj values + 'b' / 'Razón' / 'Operación' placeholders
  setText(state, r, 0, "Cj", { fill: FILL_HEADER, font: FONT_HEADER });
  setText(state, r, 1, "",   { fill: FILL_HEADER });
  for (let j = 0; j < nCols; j++) {
    setValue(state, r, VAR_START + j, snap.cj[j], { fill: FILL_HEADER, font: FONT_HEADER });
  }
  setText(state, r, B_COL,     "", { fill: FILL_HEADER });
  setText(state, r, RATIO_COL, "", { fill: FILL_HEADER });
  setText(state, r, OP_COL,    "", { fill: FILL_HEADER });
  r++;

  // Header line 2: variable names + b / Razón / Operación
  setText(state, r, 0, "Cj",            { fill: FILL_HEADER, font: FONT_HEADER });
  setText(state, r, 1, "Var. Básicas",  { fill: FILL_HEADER, font: FONT_HEADER });
  for (let j = 0; j < nCols; j++) {
    setText(state, r, VAR_START + j, displayLabels[j], { fill: FILL_HEADER, font: FONT_HEADER });
  }
  setText(state, r, B_COL,     "b",        { fill: FILL_HEADER, font: FONT_HEADER });
  setText(state, r, RATIO_COL, "Razón",    { fill: FILL_HEADER, font: FONT_HEADER });
  setText(state, r, OP_COL,    "Operación",{ fill: FILL_HEADER, font: FONT_HEADER });
  r++;

  // Data rows
  for (let i = 0; i < snap.basic.length; i++) {
    const isPivotRow = snap.pivotRow === i;
    const bIdx = snap.basic[i];

    setValue(state, r, 0, snap.cj[bIdx], { fill: isPivotRow ? FILL_PIVOT_ROW : undefined });
    setText(state, r, 1, displayLabels[bIdx], {
      fill: isPivotRow ? FILL_PIVOT_ROW : undefined,
      font: FONT_HEADER,
    });
    for (let j = 0; j < nCols; j++) {
      const isPivotCol = snap.pivotCol === j;
      let fill: typeof FILL_HEADER | undefined;
      if (isPivotRow && isPivotCol) fill = FILL_PIVOT_CELL;
      else if (isPivotRow) fill = FILL_PIVOT_ROW;
      else if (isPivotCol) fill = FILL_PIVOT_COL;
      setValue(state, r, VAR_START + j, snap.body[i][j], { fill });
    }
    setValue(state, r, B_COL, snap.rhs[i], { fill: isPivotRow ? FILL_PIVOT_ROW : undefined });

    const ratio = snap.ratios[i];
    if (ratio === null || ratio === undefined) {
      setText(state, r, RATIO_COL, "", { fill: isPivotRow ? FILL_PIVOT_ROW : undefined });
    } else {
      setValue(state, r, RATIO_COL, ratio, { fill: isPivotRow ? FILL_PIVOT_ROW : undefined });
    }

    setText(state, r, OP_COL, snap.rowOps[i] ?? "", {
      align: ALIGN_LEFT,
      fill: isPivotRow ? FILL_PIVOT_ROW : undefined,
    });
    r++;
  }

  // Zj row
  setText(state, r, 0, "",   { fill: FILL_ZJ });
  setText(state, r, 1, "Zj", { fill: FILL_ZJ, font: FONT_HEADER });
  for (let j = 0; j < nCols; j++) {
    const isPivotCol = snap.pivotCol === j;
    setValue(state, r, VAR_START + j, snap.zj[j], { fill: isPivotCol ? FILL_PIVOT_COL : FILL_ZJ });
  }
  setValue(state, r, B_COL, snap.zValue, { fill: FILL_ZJ, font: FONT_HEADER });
  setText(state, r, RATIO_COL, "", { fill: FILL_ZJ });
  setText(state, r, OP_COL,    "", { fill: FILL_ZJ });
  r++;

  // Cj - Zj row
  setText(state, r, 0, "",       { fill: FILL_ZJ });
  setText(state, r, 1, "Cj - Zj",{ fill: FILL_ZJ, font: FONT_HEADER });
  for (let j = 0; j < nCols; j++) {
    const isPivotCol = snap.pivotCol === j;
    setValue(state, r, VAR_START + j, snap.cjMinusZj[j], {
      fill: isPivotCol ? FILL_PIVOT_COL : FILL_ZJ,
      font: isPivotCol ? FONT_BOLD : undefined,
    });
  }
  setText(state, r, B_COL,     "", { fill: FILL_ZJ });
  setText(state, r, RATIO_COL, "", { fill: FILL_ZJ });
  setText(state, r, OP_COL,    "", { fill: FILL_ZJ });
  return r;
}

function writeSolutionBlock(
  state: SheetState,
  startRow: number,
  outcome: SolveOutcome,
  displayLabels: string[],
): number {
  const sf = outcome.sf;
  const lastCol = sf.columnLabels.length + 4;

  let r = startRow;
  let title: string;
  if (outcome.status === "optimal") title = "Solución óptima";
  else if (outcome.status === "unbounded") title = "Solución no acotada";
  else title = "Problema infactible";

  setText(state, r, 0, title, { font: FONT_SUBTITLE, align: ALIGN_LEFT, border: false });
  mergeRow(state, r, 0, lastCol);
  r++;

  if (outcome.status === "optimal") {
    const values: Record<string, Fraction> = {};
    for (const lbl of sf.columnLabels) values[lbl] = Fraction.ZERO;
    for (let i = 0; i < outcome.finalBasic.length; i++) {
      values[sf.columnLabels[outcome.finalBasic[i]]] = outcome.finalRhs[i];
    }
    for (let i = 0; i < sf.columnLabels.length; i++) {
      const lbl = sf.columnLabels[i];
      setText(state, r, 0, displayLabels[i], { font: FONT_BOLD, align: ALIGN_LEFT, border: false });
      setText(state, r, 1, "=", { align: ALIGN_LEFT, border: false });
      setValue(state, r, 2, values[lbl], { align: ALIGN_LEFT, border: false });
      r++;
    }
    setText(state, r, 0, "Z", { font: FONT_BOLD, align: ALIGN_LEFT, border: false });
    setText(state, r, 1, "=", { align: ALIGN_LEFT, border: false });
    setValue(state, r, 2, outcome.zValue, { font: FONT_BOLD, align: ALIGN_LEFT, border: false });
    r++;
  } else if (outcome.status === "unbounded") {
    setText(state, r, 0,
      "La columna entrante no tiene entradas positivas, así que la función objetivo no está acotada.",
      { align: ALIGN_LEFT, border: false });
    mergeRow(state, r, 0, lastCol);
    r++;
  } else {
    setText(state, r, 0,
      "Quedó al menos una variable artificial en la base con valor positivo, así que el problema no tiene solución factible.",
      { align: ALIGN_LEFT, border: false });
    mergeRow(state, r, 0, lastCol);
    r++;
  }
  return r;
}

// ---- Public API ------------------------------------------------------------

export function writeXlsxBytes(outcome: SolveOutcome): Uint8Array {
  const state = newState();
  const p = outcome.problem;
  const sf = outcome.sf;
  const nCols = sf.columnLabels.length;
  const displayLabels = buildDisplayLabels(p, sf);

  let r = 0;

  // Header: problem name
  setText(state, r, 0, p.name, { font: FONT_TITLE, align: ALIGN_LEFT, border: false });
  mergeRow(state, r, 0, nCols + 4);
  r += 2;

  const objWord = p.objective === "max" ? "Maximizar" : "Minimizar";

  // Modelo general — la formulación original del usuario, antes de añadir
  // variables de holgura/artificiales y antes de pasar todo a igualdad.
  // Solo aparecen las variables de decisión y los signos originales.
  const decisionLabels = displayLabels.slice(0, p.variables.length);
  setText(state, r, 0, "Modelo general", { font: FONT_SUBTITLE, align: ALIGN_LEFT, border: false });
  mergeRow(state, r, 0, nCols + 4);
  r++;

  const genObjTerms: LinearTerm[] = p.objectiveCoefficients.map((c, i) => [c, decisionLabels[i]]);
  setText(state, r, 0, `F.O.: ${objWord} Z = ${formatLinearExpr(genObjTerms, { keepZero: true })}`,
    { align: ALIGN_LEFT, border: false });
  mergeRow(state, r, 0, nCols + 4);
  r++;

  setText(state, r, 0, "Sujeto a:", { align: ALIGN_LEFT, border: false });
  mergeRow(state, r, 0, nCols + 4);
  r++;

  for (let i = 0; i < p.constraints.length; i++) {
    const con = p.constraints[i];
    const terms: LinearTerm[] = con.coefficients.map((v, j) => [v, decisionLabels[j]]);
    const text = `  ${i + 1}) ${formatLinearExpr(terms, { keepZero: false })} ${con.sign} ${fmtFraction(con.rhs)}`;
    setText(state, r, 0, text, { align: ALIGN_LEFT, border: false });
    mergeRow(state, r, 0, nCols + 4);
    r++;
  }

  setText(state, r, 0, `  ${decisionLabels.join(", ")} ≥ 0`, { align: ALIGN_LEFT, border: false });
  mergeRow(state, r, 0, nCols + 4);
  r += 2;

  setText(state, r, 0, "Modelo estándar", { font: FONT_SUBTITLE, align: ALIGN_LEFT, border: false });
  mergeRow(state, r, 0, nCols + 4);
  r++;

  const objTerms: LinearTerm[] = sf.cj.map((c, i) => [c, displayLabels[i]]);
  setText(state, r, 0, `F.O.: ${objWord} Z = ${formatLinearExpr(objTerms, { keepZero: true })}`,
    { align: ALIGN_LEFT, border: false });
  mergeRow(state, r, 0, nCols + 4);
  r++;

  setText(state, r, 0, "Sujeto a:", { align: ALIGN_LEFT, border: false });
  mergeRow(state, r, 0, nCols + 4);
  r++;

  for (let i = 0; i < sf.body.length; i++) {
    const terms: LinearTerm[] = sf.body[i].map((v, j) => [v, displayLabels[j]]);
    const text = `  ${i + 1}) ${formatLinearExpr(terms, { keepZero: false })} = ${fmtFraction(sf.rhs[i])}`;
    setText(state, r, 0, text, { align: ALIGN_LEFT, border: false });
    mergeRow(state, r, 0, nCols + 4);
    r++;
  }

  setText(state, r, 0, "  Xi, Si, Ai ≥ 0", { align: ALIGN_LEFT, border: false });
  mergeRow(state, r, 0, nCols + 4);
  r += 2;

  // Tableau blocks
  for (const snap of outcome.snapshots) {
    r = writeTableau(state, r, snap, displayLabels) + 2;   // blank line between blocks
  }

  // Solution
  writeSolutionBlock(state, r, outcome, displayLabels);

  // Build the SheetJS worksheet from sparse cells.
  const ws: XLSX.WorkSheet = {};
  let maxRow = 0;
  for (let row = 0; row < state.rows.length; row++) {
    const cells = state.rows[row];
    if (!cells) continue;
    if (row > maxRow) maxRow = row;
    for (const colStr of Object.keys(cells)) {
      const col = Number(colStr);
      const ref = XLSX.utils.encode_cell({ r: row, c: col });
      ws[ref] = cells[colStr];
    }
  }
  ws["!ref"] = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: maxRow, c: state.maxCol },
  });
  ws["!merges"] = state.merges;
  // Column widths: cap at [8, 28] like main.py.
  const cols: { wch: number }[] = [];
  for (let c = 0; c <= state.maxCol; c++) {
    const w = state.displayWidths.get(c) ?? 0;
    cols.push({ wch: Math.max(8, Math.min(28, w + 2)) });
  }
  ws["!cols"] = cols;

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Simplex");

  const out: ArrayBuffer | Uint8Array = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  return out instanceof Uint8Array ? out : new Uint8Array(out);
}
