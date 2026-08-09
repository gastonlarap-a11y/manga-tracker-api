import { describe, expect, it } from "bun:test";
import { DEFAULT_PORT, parsePort } from "./port";

describe("parsePort", () => {
  it("defaults when PORT is absent or blank", () => {
    expect(parsePort(undefined)).toBe(DEFAULT_PORT);
    expect(parsePort("")).toBe(DEFAULT_PORT);
    expect(parsePort("  ")).toBe(DEFAULT_PORT);
  });

  it("takes any port an installer may have chosen", () => {
    expect(parsePort("5150")).toBe(5150);
    expect(parsePort(" 61234 ")).toBe(61234);
    expect(parsePort("65535")).toBe(65535);
  });

  it("names the bad value instead of listening on NaN", () => {
    // `Number("51 50")` is NaN, and Bun's own error for it does not mention
    // PORT at all — on someone else's machine that is an unfixable failure.
    expect(() => parsePort("51 50")).toThrow(/"51 50"/);
    expect(() => parsePort("abc")).toThrow(/PORT/);
    expect(() => parsePort("5150.5")).toThrow(/PORT/);
    expect(() => parsePort("-1")).toThrow(/PORT/);
    expect(() => parsePort("70000")).toThrow(/PORT/);
  });

  it("refuses 0, which would hide the port from everything that must reach it", () => {
    expect(() => parsePort("0")).toThrow(/PORT/);
  });
});
