// Problem schema + load/validate. Port of main.py §3.

import { Fraction, type FractionLike } from "./fraction";

export type Sign = "<=" | "=" | ">=";
export type Objective = "max" | "min";

export interface Constraint {
  name: string;
  coefficients: Fraction[];
  sign: Sign;
  rhs: Fraction;
}

export interface Problem {
  name: string;
  objective: Objective;
  variables: string[];
  objectiveCoefficients: Fraction[];
  constraints: Constraint[];
  // Decision-variable name → human-friendly label (e.g. "xA" → "congelador A").
  // Used only for display; absent entries fall back to the technical name.
  variableLabels?: Record<string, string>;
}

export interface RawConstraint {
  name?: string;
  coefficients: FractionLike[];
  sign: Sign;
  rhs: FractionLike;
}

export interface RawProblem {
  name?: string;
  objective: Objective;
  variables: string[];
  objective_coefficients: FractionLike[];
  variable_labels?: Array<{ variable: string; label: string }>;
  constraints: RawConstraint[];
}

const FLIP: Record<Sign, Sign> = { "<=": ">=", ">=": "<=", "=": "=" };

export function loadProblem(raw: RawProblem): Problem {
  if (!raw || typeof raw !== "object") {
    throw new Error("problem: expected an object");
  }
  for (const key of ["objective", "variables", "objective_coefficients", "constraints"] as const) {
    if (!(key in raw)) throw new Error(`missing required key: '${key}'`);
  }

  const name = raw.name ?? "Problem";
  const objective = String(raw.objective).toLowerCase() as Objective;
  if (objective !== "max" && objective !== "min") {
    throw new Error(`objective must be 'max' or 'min', got '${raw.objective}'`);
  }

  const variables = [...raw.variables];
  if (variables.length === 0) throw new Error("variables list is empty");

  const objCoeffsRaw = raw.objective_coefficients;
  if (objCoeffsRaw.length !== variables.length) {
    throw new Error(
      `objective_coefficients has length ${objCoeffsRaw.length} but variables has length ${variables.length}`,
    );
  }
  const objectiveCoefficients = objCoeffsRaw.map((v, i) => {
    try { return Fraction.from(v); }
    catch (e) { throw new Error(`objective_coefficients[${i}]: ${(e as Error).message}`); }
  });

  if (!raw.constraints.length) throw new Error("constraints list is empty");
  const constraints: Constraint[] = raw.constraints.map((c, i) => {
    for (const k of ["coefficients", "sign", "rhs"] as const) {
      if (!(k in c)) throw new Error(`constraint[${i}]: missing key '${k}'`);
    }
    if (c.coefficients.length !== variables.length) {
      throw new Error(
        `constraint[${i}]: coefficients length ${c.coefficients.length} != variables length ${variables.length}`,
      );
    }
    if (c.sign !== "<=" && c.sign !== "=" && c.sign !== ">=") {
      throw new Error(`constraint[${i}]: sign must be one of <=, =, >=, got '${c.sign}'`);
    }
    let coeffs = c.coefficients.map((v, j) => {
      try { return Fraction.from(v); }
      catch (e) { throw new Error(`constraint[${i}].coefficients[${j}]: ${(e as Error).message}`); }
    });
    let rhs: Fraction;
    try { rhs = Fraction.from(c.rhs); }
    catch (e) { throw new Error(`constraint[${i}].rhs: ${(e as Error).message}`); }
    let sign: Sign = c.sign;
    if (rhs.lt(0n)) {
      coeffs = coeffs.map((x) => x.neg());
      rhs = rhs.neg();
      sign = FLIP[sign];
    }
    return {
      name: c.name ?? `R${i + 1}`,
      coefficients: coeffs,
      sign,
      rhs,
    };
  });

  let variableLabels: Record<string, string> | undefined;
  if (raw.variable_labels && raw.variable_labels.length > 0) {
    variableLabels = {};
    for (const { variable, label } of raw.variable_labels) {
      const trimmed = String(label ?? "").trim();
      if (trimmed && variable) variableLabels[variable] = trimmed;
    }
    if (Object.keys(variableLabels).length === 0) variableLabels = undefined;
  }

  return { name, objective, variables, objectiveCoefficients, constraints, variableLabels };
}
