// Render Fraction / BigM as readable text. Port of main.py §2.

import { Fraction } from "./fraction";
import { BigM } from "./bigm";

export function fmtFraction(f: Fraction): string {
  if (f.isZero()) return "0";
  if (f.isInteger()) return f.num.toString();
  const sign = f.num < 0n ? "-" : "";
  const n = f.num < 0n ? -f.num : f.num;
  const d = f.den;
  const whole = n / d;
  const rem = n % d;
  if (whole === 0n) return `${sign}${rem}/${d}`;
  return `${sign}${whole} ${rem}/${d}`;
}

export function fmtBigM(b: BigM | Fraction): string {
  if (b instanceof Fraction) return fmtFraction(b);
  const c = b.c;
  const m = b.m;
  if (m.isZero()) return fmtFraction(c);

  const mTermFor = (mag: Fraction): string => {
    if (mag.eq(1n)) return "M";
    if (mag.eq(-1n)) return "-M";
    return `${fmtFraction(mag)}M`;
  };

  if (c.isZero()) {
    return mTermFor(m);
  }
  if (m.gt(0n)) {
    const mPart = m.eq(1n) ? "M" : `${fmtFraction(m)}M`;
    if (c.gt(0n)) return `${fmtFraction(c)} + ${mPart}`;
    return `${mPart} - ${fmtFraction(c.neg())}`;
  }
  // m < 0
  const absM = m.neg();
  const mPart = absM.eq(1n) ? "M" : `${fmtFraction(absM)}M`;
  return `${fmtFraction(c)} - ${mPart}`;
}

export type LinearTerm = [BigM | Fraction, string];

export function formatLinearExpr(terms: LinearTerm[], opts: { keepZero: boolean }): string {
  const pieces: string[] = [];
  for (const [coeff, label] of terms) {
    const isBigM = coeff instanceof BigM;
    const isZero = isBigM ? coeff.isZero() : coeff.isZero();
    if (isZero && !opts.keepZero) continue;

    let negate: boolean;
    let mag: BigM | Fraction;
    let magStr: string;
    let isOne: boolean;

    if (isBigM) {
      negate = coeff.m.lt(0n) || (coeff.m.isZero() && coeff.c.lt(0n));
      mag = negate ? coeff.neg() : coeff;
      magStr = fmtBigM(mag as BigM);
      isOne = (mag as BigM).c.eq(1n) && (mag as BigM).m.isZero();
    } else {
      negate = coeff.lt(0n);
      mag = negate ? coeff.neg() : coeff;
      magStr = fmtFraction(mag as Fraction);
      isOne = (mag as Fraction).eq(1n);
    }

    const connector = negate ? "-" : "+";
    const body = isOne ? label : `${magStr}·${label}`;
    if (pieces.length === 0) {
      pieces.push(negate ? `-${body}` : body);
    } else {
      pieces.push(` ${connector} ${body}`);
    }
  }
  return pieces.length ? pieces.join("") : "0";
}
