// Zod schemas for the MCP tool inputs/outputs.

import { z } from "zod";

const numberOrFractionString = z.union([
  z.number(),
  z.string().regex(/^[+-]?\s*(?:\d+(?:\.\d+)?(?:\/\d+)?|\d*\.\d+)$/, {
    message: "expected number or fraction string like '1/3' / '0.25' / '-5'",
  }),
]);

// Some MCP clients (notably Kai 9000's `ToolExecutor.toMap` in its Kotlin
// codebase) flatten top-level array/object tool arguments to JSON-encoded
// strings before sending them. As a result our server receives e.g.
// `"variables": "[\"x\",\"y\"]"` instead of `"variables": ["x","y"]`, and
// Zod rejects with "expected array, received string".
//
// Wrapping each array field with this preprocessor makes the server tolerant
// of that pattern without affecting compliant clients: if the input is a
// string that happens to JSON-decode into an array, we use the decoded value;
// otherwise we pass the value through untouched and let the inner schema
// validate normally.
function tolerateStringifiedArray<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((val) => {
    if (typeof val === "string") {
      try {
        const parsed = JSON.parse(val);
        return Array.isArray(parsed) ? parsed : val;
      } catch {
        return val;
      }
    }
    return val;
  }, schema);
}

export const constraintSchema = z.object({
  name: z.string().optional(),
  coefficients: tolerateStringifiedArray(
    z.array(numberOrFractionString).min(1, "constraint must have at least one coefficient"),
  ),
  sign: z.enum(["<=", "=", ">="]),
  rhs: numberOrFractionString,
});

export const problemSchema = z.object({
  name: z.string().optional(),
  objective: z.enum(["max", "min"]),
  variables: tolerateStringifiedArray(
    z.array(z.string().min(1)).min(1, "at least one decision variable required"),
  ),
  objective_coefficients: tolerateStringifiedArray(
    z.array(numberOrFractionString).min(1, "at least one objective coefficient required"),
  ),
  // Optional natural-language labels for decision variables, expressed as
  // pairs (e.g. [{variable: "xA", label: "congelador A"}, ...]). The pair
  // shape avoids JSON-Schema `additionalProperties` objects, which some
  // LLM clients (notably Kai 9000's Kotlin schema converter) crash on.
  // Slack/artificial labels are derived automatically from each
  // constraint's `name`.
  variable_labels: tolerateStringifiedArray(
    z.array(z.object({
      variable: z.string().min(1),
      label: z.string().min(1),
    })),
  ).optional(),
  constraints: tolerateStringifiedArray(
    z.array(constraintSchema).min(1, "at least one constraint required"),
  ),
  delivery: z.enum(["url", "inline"]).optional(),
});

export type ProblemInput = z.infer<typeof problemSchema>;
export type ConstraintInput = z.infer<typeof constraintSchema>;

export const problemSchemaShape = problemSchema.shape;
