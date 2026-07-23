import { describe, expect, it, vi } from "vitest";

import { projectionReachedHead, startServerRuntime } from "../src/server-runtime.js";

describe("server runtime projection startup", () => {
  it("does not block a serverless function on its listening promise or chain projection", async () => {
    const listen = vi.fn(() => new Promise<never>(() => undefined));
    const syncProjection = vi.fn(() => Promise.resolve(undefined));

    await startServerRuntime({
      serverless: true,
      listen,
      syncProjection,
      onBackgroundError: vi.fn(),
    });

    expect(listen).toHaveBeenCalledOnce();
    expect(syncProjection).not.toHaveBeenCalled();
  });

  it("waits for a persistent local server before its initial projection check", async () => {
    const listen = vi.fn(() => Promise.resolve(undefined));
    const syncProjection = vi.fn(() => Promise.resolve(undefined));

    await startServerRuntime({
      serverless: false,
      listen,
      syncProjection,
      onBackgroundError: vi.fn(),
    });

    expect(listen).toHaveBeenCalledOnce();
    expect(syncProjection).toHaveBeenCalledOnce();
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
