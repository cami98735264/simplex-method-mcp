// BigInt-backed exact rational. Mirrors Python's fractions.Fraction.
// Stays exact across the entire simplex run, no floating-point drift.

export type FractionLike = Fraction | bigint | number | string;

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a;
}

function parseToFraction(value: number | string): { num: bigint; den: bigint } {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`cannot represent non-finite number ${value} as a fraction`);
    }
    if (Number.isInteger(value)) {
      return { num: BigInt(value), den: 1n };
    }
    // Decimal → fraction by string parsing (avoids floating-point precision loss).
    return parseToFraction(value.toString());
  }
  const s = value.trim();
  if (s.length === 0) throw new Error("empty string is not a number");

  // "p/q"
  const slash = s.indexOf("/");
  if (slash >= 0) {
    const a = parseToFraction(s.slice(0, slash));
    const b = parseToFraction(s.slice(slash + 1));
    if (b.num === 0n) throw new Error("division by zero");
    return { num: a.num * b.den, den: a.den * b.num };
  }

  // optional sign
  let sign = 1n;
  let rest = s;
  if (rest[0] === "+" || rest[0] === "-") {
    if (rest[0] === "-") sign = -1n;
    rest = rest.slice(1);
  }

  // scientific notation
  const eIdx = rest.search(/[eE]/);
  let exp = 0;
  if (eIdx >= 0) {
    exp = Number(rest.slice(eIdx + 1));
    if (!Number.isInteger(exp)) throw new Error(`bad exponent in ${s}`);
    rest = rest.slice(0, eIdx);
  }

  // decimal split
  const dot = rest.indexOf(".");
  let intPart = rest;
  let fracPart = "";
  if (dot >= 0) {
    intPart = rest.slice(0, dot);
    fracPart = rest.slice(dot + 1);
  }
  if (intPart === "" && fracPart === "") throw new Error(`cannot parse '${s}' as a number`);
  if (!/^\d*$/.test(intPart) || !/^\d*$/.test(fracPart)) {
    throw new Error(`cannot parse '${s}' as a number`);
  }

  let num = BigInt((intPart || "0") + fracPart);
  let den = 10n ** BigInt(fracPart.length);
  if (exp > 0) num *= 10n ** BigInt(exp);
  if (exp < 0) den *= 10n ** BigInt(-exp);
  return { num: sign * num, den };
}

export class Fraction {
  readonly num: bigint;
  readonly den: bigint;

  private constructor(num: bigint, den: bigint) {
    this.num = num;
    this.den = den;
  }

  static from(value: FractionLike): Fraction {
    if (value instanceof Fraction) return value;
    if (typeof value === "bigint") return new Fraction(value, 1n).normalize();
    const { num, den } = parseToFraction(value);
    return new Fraction(num, den).normalize();
  }

  private normalize(): Fraction {
    let { num, den } = this;
    if (den === 0n) throw new Error("zero denominator");
    if (den < 0n) {
      num = -num;
      den = -den;
    }
    const g = gcd(num, den);
    return g === 0n || g === 1n ? new Fraction(num, den) : new Fraction(num / g, den / g);
  }

  add(other: FractionLike): Fraction {
    const o = Fraction.from(other);
    return new Fraction(this.num * o.den + o.num * this.den, this.den * o.den).normalize();
  }

  sub(other: FractionLike): Fraction {
    const o = Fraction.from(other);
    return new Fraction(this.num * o.den - o.num * this.den, this.den * o.den).normalize();
  }

  mul(other: FractionLike): Fraction {
    const o = Fraction.from(other);
    return new Fraction(this.num * o.num, this.den * o.den).normalize();
  }

  div(other: FractionLike): Fraction {
    const o = Fraction.from(other);
    if (o.num === 0n) throw new Error("division by zero");
    return new Fraction(this.num * o.den, this.den * o.num).normalize();
  }

  neg(): Fraction {
    return new Fraction(-this.num, this.den);
  }

  abs(): Fraction {
    return this.num < 0n ? this.neg() : this;
  }

  cmp(other: FractionLike): number {
    const o = Fraction.from(other);
    const diff = this.num * o.den - o.num * this.den;
    return diff === 0n ? 0 : diff < 0n ? -1 : 1;
  }

  eq(other: FractionLike): boolean { return this.cmp(other) === 0; }
  lt(other: FractionLike): boolean { return this.cmp(other) < 0; }
  le(other: FractionLike): boolean { return this.cmp(other) <= 0; }
  gt(other: FractionLike): boolean { return this.cmp(other) > 0; }
  ge(other: FractionLike): boolean { return this.cmp(other) >= 0; }

  isZero(): boolean { return this.num === 0n; }
  isInteger(): boolean { return this.den === 1n; }

  toNumber(): number {
    // For Excel's native numeric storage. May lose precision for huge
    // numerators/denominators — callers that need exactness use the rational
    // form directly.
    return Number(this.num) / Number(this.den);
  }

  static readonly ZERO = new Fraction(0n, 1n);
  static readonly ONE = new Fraction(1n, 1n);
  static readonly NEG_ONE = new Fraction(-1n, 1n);
}
