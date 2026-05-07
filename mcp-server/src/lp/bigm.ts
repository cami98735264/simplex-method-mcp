// BigM: a value of the form c + m·M where M is a symbolic large positive.
// Direct port of main.py §1.

import { Fraction, type FractionLike } from "./fraction";

export type BigMLike = BigM | FractionLike;

export class BigM {
  readonly c: Fraction;
  readonly m: Fraction;

  constructor(c: FractionLike = 0n, m: FractionLike = 0n) {
    this.c = Fraction.from(c);
    this.m = Fraction.from(m);
  }

  static coerce(value: BigMLike): BigM {
    if (value instanceof BigM) return value;
    return new BigM(Fraction.from(value), Fraction.ZERO);
  }

  add(other: BigMLike): BigM {
    const o = BigM.coerce(other);
    return new BigM(this.c.add(o.c), this.m.add(o.m));
  }

  sub(other: BigMLike): BigM {
    const o = BigM.coerce(other);
    return new BigM(this.c.sub(o.c), this.m.sub(o.m));
  }

  mul(other: BigMLike): BigM {
    const o = BigM.coerce(other);
    if (!this.m.isZero() && !o.m.isZero()) {
      throw new Error("M · M term is not supported");
    }
    return new BigM(this.c.mul(o.c), this.c.mul(o.m).add(this.m.mul(o.c)));
  }

  div(other: FractionLike | BigM): BigM {
    let denom: Fraction;
    if (other instanceof BigM) {
      if (!other.m.isZero()) throw new Error("division by a non-scalar BigM is not supported");
      denom = other.c;
    } else {
      denom = Fraction.from(other);
    }
    return new BigM(this.c.div(denom), this.m.div(denom));
  }

  neg(): BigM {
    return new BigM(this.c.neg(), this.m.neg());
  }

  // M is treated as +∞: order by m first, then by c.
  cmp(other: BigMLike): number {
    const o = BigM.coerce(other);
    const dm = this.m.cmp(o.m);
    if (dm !== 0) return dm;
    return this.c.cmp(o.c);
  }

  eq(other: BigMLike): boolean { return this.cmp(other) === 0; }
  lt(other: BigMLike): boolean { return this.cmp(other) < 0; }
  le(other: BigMLike): boolean { return this.cmp(other) <= 0; }
  gt(other: BigMLike): boolean { return this.cmp(other) > 0; }
  ge(other: BigMLike): boolean { return this.cmp(other) >= 0; }

  isZero(): boolean { return this.c.isZero() && this.m.isZero(); }

  static readonly ZERO = new BigM(0n, 0n);
}
