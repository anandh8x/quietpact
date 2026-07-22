import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const publicSurfaces = ["README.md", "apps/web/src/App.tsx"] as const;
const prohibitedClaims = [
  "Powered by Arc Privacy",
  "Only the parties can see the payment amount",
] as const;

describe("public privacy claims", () => {
  it("keeps the required public-payment notice on public surfaces", async () => {
    const contents = await Promise.all(publicSurfaces.map(async (path) => readFile(path, "utf8")));

    for (const content of contents) {
      expect(content).toMatch(/payments? (?:are|is) public onchain/i);
    }
  });

  it("does not publish unsupported privacy claims", async () => {
    const contents = await Promise.all(publicSurfaces.map(async (path) => readFile(path, "utf8")));

    for (const content of contents) {
      for (const claim of prohibitedClaims) {
        expect(content).not.toContain(claim);
      }
    }
  });
});
