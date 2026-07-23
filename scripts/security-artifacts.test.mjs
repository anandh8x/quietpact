import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "..");

describe("release security artifacts", () => {
  it("records explicit threats, residual risks, and release blockers", () => {
    const model = JSON.parse(
      readFileSync(resolve(projectRoot, "security/threat-model.json"), "utf8"),
    );
    const ids = model.threats.map((threat) => threat.id);

    expect(model.releaseClass).toBe("UNAUDITED_TESTNET_PROTOTYPE");
    expect(new Set(ids).size).toBe(ids.length);
    expect(model.threats.length).toBeGreaterThanOrEqual(8);
    expect(model.releaseBlockers.length).toBeGreaterThan(0);
    for (const threat of model.threats) {
      expect(threat.controls.length).toBeGreaterThan(0);
      expect(threat.releaseRequirement.length).toBeGreaterThan(0);
    }
  });

  it("commits a stable production CycloneDX dependency inventory", () => {
    const sbom = JSON.parse(readFileSync(resolve(projectRoot, "security/sbom.cdx.json"), "utf8"));
    const references = sbom.components.map((component) => component["bom-ref"]);

    expect(sbom.bomFormat).toBe("CycloneDX");
    expect(sbom.specVersion).toBe("1.6");
    expect(sbom.serialNumber).toBeUndefined();
    expect(sbom.metadata.timestamp).toBeUndefined();
    expect(sbom.metadata.component.name).toBe("quietpact");
    expect(sbom.components.length).toBeGreaterThan(0);
    expect(new Set(references).size).toBe(references.length);
  });

  it("defines an independent review scope without self-approving release", () => {
    const scope = JSON.parse(
      readFileSync(resolve(projectRoot, "security/review-scope.json"), "utf8"),
    );

    expect(scope.reviewType).toBe("INDEPENDENT_TESTNET_PROTOTYPE_SECURITY_REVIEW");
    expect(scope.inScope).toContain("contracts/src/**");
    expect(scope.requiredVerificationCommands).toContain("pnpm contracts:test");
    expect(scope.exitCriteria).toContain("No unresolved critical or high finding.");
    expect(JSON.stringify(scope)).not.toMatch(/audit (passed|approved)|production.ready/i);
  });
});
