import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const requiredNoticeSurfaces = ["README.md", "apps/web/src/App.tsx"] as const;
const claimSurfaces = [...requiredNoticeSurfaces, "apps/web/index.html"] as const;
const prohibitedClaims = [
  /Powered by Arc Privacy/i,
  /Only the parties can see the payment amount/i,
  /\b(?:private|anonymous|untraceable) payments?\b/i,
  /\bpayments? (?:are|is) settled privately\b/i,
] as const;

describe("public privacy claims", () => {
  it("keeps the required public-payment notice on public surfaces", async () => {
    const contents = await Promise.all(
      requiredNoticeSurfaces.map(async (path) => readFile(path, "utf8")),
    );

    for (const content of contents) {
      expect(content).toMatch(/payments? (?:are|is) public onchain/i);
    }
  });

  it("keeps the prototype maturity notice on the website", async () => {
    const website = await readFile("apps/web/src/App.tsx", "utf8");

    expect(website).toContain("Unaudited. No real funds. Not an Arc testnet deployment.");
  });

  it("does not publish unsupported privacy claims", async () => {
    const contents = await Promise.all(claimSurfaces.map(async (path) => readFile(path, "utf8")));

    for (const content of contents) {
      for (const claim of prohibitedClaims) {
        expect(content).not.toMatch(claim);
      }
    }
  });
});
