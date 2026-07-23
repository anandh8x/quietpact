import { describe, expect, it, vi } from "vitest";

import { projectionReachedHead, syncProjectionOnStartup } from "../src/server-runtime.js";

describe("server runtime projection startup", () => {
  it("does not block a serverless function on chain projection", async () => {
    const sync = vi.fn(() => Promise.resolve(undefined));

    await syncProjectionOnStartup(true, sync);

    expect(sync).not.toHaveBeenCalled();
  });

  it("keeps the initial projection check for a persistent local server", async () => {
    const sync = vi.fn(() => Promise.resolve(undefined));

    await syncProjectionOnStartup(false, sync);

    expect(sync).toHaveBeenCalledOnce();
  });

  it("recognizes a partial final batch as the live chain head", () => {
    expect(projectionReachedHead({ fromBlock: 101n, throughBlock: 120n }, 500n)).toBe(true);
    expect(projectionReachedHead({ fromBlock: 101n, throughBlock: 600n }, 500n)).toBe(false);
    expect(projectionReachedHead({ fromBlock: null, throughBlock: 600n }, 500n)).toBe(true);
  });

  it("rejects a non-positive block range", () => {
    expect(() => projectionReachedHead({ fromBlock: 101n, throughBlock: 120n }, 0n)).toThrow(
      "Projection block range must be positive",
    );
  });
});
