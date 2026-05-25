import { describe, expect, it } from "vitest";

import { flightLevel, fmt, headingCompass, speedKt, vsFpm } from "./format";

describe("format helpers", () => {
  it("formats nullable numbers consistently", () => {
    expect(fmt(null)).toBe("--");
    expect(fmt(Number.NaN)).toBe("--");
    expect(fmt(123.456, { suffix: " kt", digits: 1 })).toBe("123.5 kt");
    expect(fmt(12, { sign: true })).toBe("+12");
  });

  it("converts aviation units used by the UI", () => {
    expect(speedKt(100)).toBeCloseTo(194.384);
    expect(vsFpm(5)).toBeCloseTo(984.25);
    expect(flightLevel(10_668)).toBe("FL350");
  });

  it("maps headings to compass labels", () => {
    expect(headingCompass(null)).toBe("--");
    expect(headingCompass(0)).toBe("N");
    expect(headingCompass(91)).toBe("E");
    expect(headingCompass(359)).toBe("N");
  });
});
