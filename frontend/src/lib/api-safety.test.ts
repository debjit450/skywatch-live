import { describe, expect, it } from "vitest";

import {
  isFiniteCoordinate,
  normalizeCallsign,
  normalizeIcao24,
  normalizeRegistration,
  parseOptionalCoordinate,
} from "./api-safety";

describe("api-safety", () => {
  it("normalizes valid identifiers and rejects malformed values", () => {
    expect(normalizeIcao24(" ABC123 ")).toBe("abc123");
    expect(normalizeIcao24("abc12z")).toBeNull();

    expect(normalizeCallsign(" ai 101 ")).toBe("AI101");
    expect(normalizeCallsign("bad/call")).toBeNull();

    expect(normalizeRegistration(" vt-abC ")).toBe("VT-ABC");
    expect(normalizeRegistration("too_long_registration")).toBeNull();
  });

  it("parses optional coordinate inputs with range validation", () => {
    expect(parseOptionalCoordinate("", -90, 90)).toEqual({ value: null, valid: true });
    expect(parseOptionalCoordinate("28.61", -90, 90)).toEqual({ value: 28.61, valid: true });
    expect(parseOptionalCoordinate("91", -90, 90)).toEqual({ value: null, valid: false });
    expect(parseOptionalCoordinate("north", -90, 90)).toEqual({ value: null, valid: false });
  });

  it("accepts only finite latitude and longitude pairs", () => {
    expect(isFiniteCoordinate(28.61, 77.2)).toBe(true);
    expect(isFiniteCoordinate(91, 77.2)).toBe(false);
    expect(isFiniteCoordinate(28.61, Number.NaN)).toBe(false);
  });
});
