import { address } from "@quietpact/domain";
import type { Hash, PublicClient } from "viem";
import { describe, expect, it } from "vitest";

import { createViemInvoiceProjector, type InvoiceProjectionRepository } from "../src/index.js";

describe("Viem invoice projector RPC batching", () => {
  it("queries all invoice events once within a bounded block range", async () => {
    const logQueries: Array<Record<string, unknown>> = [];
    const applied: Array<{
      throughBlock: bigint;
      throughBlockHash: Hash;
      reset: boolean;
    }> = [];
    const blockHash: Hash = `0x${"11".repeat(32)}`;
    const publicClient = {
      getBlock(input: { blockTag?: string; blockNumber?: bigint }) {
        if (input.blockTag === "latest") {
          return Promise.resolve({ number: 5_000n, hash: `0x${"22".repeat(32)}` });
        }
        expect(input.blockNumber).toBe(599n);
        return Promise.resolve({ number: 599n, hash: blockHash });
      },
      getLogs(input: Record<string, unknown>) {
        logQueries.push(input);
        return Promise.resolve([]);
      },
    } as unknown as PublicClient;
    const repository: InvoiceProjectionRepository = {
      cursor: () => Promise.resolve(null),
      apply(batch) {
        applied.push({
          throughBlock: batch.throughBlock,
          throughBlockHash: batch.throughBlockHash,
          reset: batch.reset,
        });
        return Promise.resolve();
      },
      view: () => Promise.resolve(null),
    };
    const projector = createViemInvoiceProjector({
      registry: address("0x1000000000000000000000000000000000000001"),
      publicClient,
      repository,
      startBlock: 100n,
      maxBlockRange: 500n,
    });

    await expect(projector.sync()).resolves.toEqual({
      fromBlock: 100n,
      throughBlock: 599n,
      events: 0,
    });
    expect(logQueries).toHaveLength(1);
    expect(logQueries[0]).toMatchObject({
      fromBlock: 100n,
      toBlock: 599n,
    });
    expect(logQueries[0]?.events).toHaveLength(3);
    expect(applied).toEqual([
      {
        throughBlock: 599n,
        throughBlockHash: blockHash,
        reset: false,
      },
    ]);
  });
});
