import { describe, expect, it } from "vitest";
import { Fraction } from "../src/lp/fraction";

describe("Fraction", () => {
  it("parses integers, decimals, fractions", () => {
    expect(Fraction.from(3).toNumber()).toBe(3);
    expect(Fraction.from("1/3").mul(3).eq(Fraction.ONE)).toBe(true);
    expect(Fraction.from("0.25").eq(Fraction.from("1/4"))).toBe(true);
    expect(Fraction.from("-7").eq(-7n)).toBe(true);
  });

  it("performs exact arithmetic", () => {
    const a = Fraction.from("1/3");
    const b = Fraction.from("1/6");
    expect(a.add(b).eq(Fraction.from("1/2"))).toBe(true);
    expect(a.sub(b).eq(Fraction.from("1/6"))).toBe(true);
    expect(a.mul(b).eq(Fraction.from("1/18"))).toBe(true);
    expect(a.div(b).eq(2n)).toBe(true);
  });

  it("normalizes negatives in the numerator", () => {
    const f = Fraction.from("-2/-3");
    expect(f.eq(Fraction.from("2/3"))).toBe(true);
  });

  it("rejects zero denominators", () => {
    expect(() => Fraction.from("1/0")).toThrow();
  });
});
