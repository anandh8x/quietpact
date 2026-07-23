export async function syncProjectionOnStartup(
  serverless: boolean,
  sync: () => unknown,
): Promise<void> {
  if (!serverless) await sync();
}

export interface ProjectionProgress {
  readonly fromBlock: bigint | null;
  readonly throughBlock: bigint;
}

export function projectionReachedHead(result: ProjectionProgress, maxBlockRange: bigint): boolean {
  if (maxBlockRange <= 0n) throw new Error("Projection block range must be positive");
  if (result.fromBlock === null) return true;
  return result.throughBlock - result.fromBlock + 1n < maxBlockRange;
}
