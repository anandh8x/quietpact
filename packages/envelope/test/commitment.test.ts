import { describe, expect, it } from "vitest";
import { canonicalize, commitmentFor, type CommitmentContext } from "../src/index.js";

const context: CommitmentContext = {
  chainId: 5042002n,
  registry: "0x1111111111111111111111111111111111111111",
  workflowId: `0x${"22".repeat(32)}`,
  payer: "0x3333333333333333333333333333333333333333",
  payee: "0x4444444444444444444444444444444444444444",
};

describe("invoice commitments", () => {
  it("matches the fixed vector asserted by Solidity", () => {
    const value = { amount: "1250.00", currency: "USDC", invoiceNumber: "INV-001" };
    const salt = `0x${"55".repeat(32)}` as const;

    expect(new TextDecoder().decode(canonicalize(value))).toBe(
      '{"amount":"1250.00","currency":"USDC","invoiceNumber":"INV-001"}',
    );
    expect(commitmentFor(context, value, salt)).toBe(
      "0x8bfbe9d3530f21d5d50cf416cdab34a7cc8166dfdc5c8deda2f1a6b31a656bec",
    );
  });

  it("binds every public workflow field", () => {
    const value = { invoiceNumber: "INV-001" };
    const salt = `0x${"55".repeat(32)}` as const;
    const original = commitmentFor(context, value, salt);

    expect(commitmentFor({ ...context, chainId: 5042003n }, value, salt)).not.toBe(original);
    expect(
      commitmentFor(
        { ...context, registry: "0x9999999999999999999999999999999999999999" },
        value,
        salt,
      ),
    ).not.toBe(original);
  });
});
