export interface ServerRuntimeOptions {
  readonly serverless: boolean;
  readonly listen: () => Promise<unknown>;
  readonly syncProjection: () => unknown;
  readonly onBackgroundError: (error: unknown) => void;
}

export async function startServerRuntime(options: ServerRuntimeOptions): Promise<void> {
  const listening = options.listen();
  if (options.serverless) {
    void listening.catch(options.onBackgroundError);
    return;
  }
  await listening;
  await options.syncProjection();
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
