import { describe, expect, it } from "vitest";

import { canonicalize } from "../src/index.js";

describe("canonical encoding", () => {
  it("produces identical bytes regardless of object key insertion order", () => {
    const first = {
      currency: "USDC",
      invoiceNumber: "INV-001",
      lines: [{ quantity: 2, description: "Security review" }],
    };
    const second = {
      lines: [{ description: "Security review", quantity: 2 }],
      invoiceNumber: "INV-001",
      currency: "USDC",
    };

    expect(canonicalize(first)).toEqual(canonicalize(second));
    expect(new TextDecoder().decode(canonicalize(first))).toBe(
      '{"currency":"USDC","invoiceNumber":"INV-001","lines":[{"description":"Security review","quantity":2}]}',
    );
  });

  it.each([
    ["undefined", undefined],
    ["bigint", 1n],
    ["non-finite number", Number.POSITIVE_INFINITY],
    ["class instance", new Date(0)],
  ])("rejects unsupported %s values", (_name, value) => {
    expect(() => canonicalize(value)).toThrow(TypeError);
  });

  it("rejects cycles", () => {
    const value: Record<string, unknown> = {};
    value.self = value;

    expect(() => canonicalize(value)).toThrow("cycles");
  });

  it("rejects symbol-keyed data instead of silently dropping it", () => {
    const value = { visible: true, [Symbol("secret")]: "hidden" };

    expect(() => canonicalize(value)).toThrow("symbol");
  });
});
