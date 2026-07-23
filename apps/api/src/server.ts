import { createViemInvoiceProjector } from "@quietpact/chain-records";
import { address } from "@quietpact/domain";
import { createPublicClient, http } from "viem";

import { createApp } from "./app.js";
import { openConfiguredQuietPactDatabase } from "./configured-persistence.js";
import { createOperationalMonitor } from "./operational-monitor.js";
import { projectionReachedHead, syncProjectionOnStartup } from "./server-runtime.js";
import { createWalletAuth } from "./wallet-auth.js";

const serverless = process.env.VERCEL === "1";
const port = Number(process.env.QUIETPACT_API_PORT ?? process.env.PORT ?? 3001);
const database = await openConfiguredQuietPactDatabase();
const chainId = process.env.QUIETPACT_CHAIN_ID ?? "31337";
const vercelHostname = process.env.VERCEL_URL?.trim();
const authenticationOrigin =
  process.env.QUIETPACT_AUTH_ORIGIN ??
  (vercelHostname === undefined || vercelHostname === ""
    ? "local development"
    : `https://${vercelHostname}`);
const walletAuth = createWalletAuth(database.walletAuth, {
  authenticationOrigin,
  chainId,
});
const registry = address(
  process.env.QUIETPACT_REGISTRY_ADDRESS ?? "0x5FbDB2315678afecb367f032d93F642f64180aa3",
);
const projection = database.invoiceProjection(`${chainId}:${registry}`);
const projectorDisabled = process.env.QUIETPACT_PROJECTOR_DISABLED === "1";
const projectorBlockRange = BigInt(process.env.QUIETPACT_PROJECTOR_BLOCK_RANGE ?? "500");
const operationalMonitor = createOperationalMonitor({
  checkDatabase: () => database.checkHealth(),
  databaseSchemaVersion: database.schemaVersion,
  projectorDisabled,
});
const projector = createViemInvoiceProjector({
  registry,
  publicClient: createPublicClient({
    transport: http(process.env.QUIETPACT_RPC_URL ?? "http://127.0.0.1:8545"),
  }),
  repository: projection,
  startBlock: BigInt(process.env.QUIETPACT_REGISTRY_START_BLOCK ?? "0"),
  maxBlockRange: projectorBlockRange,
});
type ProjectionSyncResult = Awaited<ReturnType<typeof projector.sync>>;
let activeProjectionSync: Promise<ProjectionSyncResult> | null = null;
const syncProjection = async () => {
  if (projectorDisabled) return null;
  if (activeProjectionSync !== null) return activeProjectionSync;
  activeProjectionSync = projector.sync();
  try {
    const result = await activeProjectionSync;
    operationalMonitor.projectorSucceeded();
    if (result.events > 0) app.log.info(result, "invoice projection synchronized");
    return result;
  } catch (error) {
    operationalMonitor.projectorFailed();
    app.log.warn(
      { errorName: error instanceof Error ? error.name : "UnknownError" },
      "invoice projection synchronization failed",
    );
    throw error;
  } finally {
    activeProjectionSync = null;
  }
};
const syncProjectionToHead = async () => {
  for (let batch = 0; batch < 100; batch += 1) {
    const result = await syncProjection();
    if (result === null || projectionReachedHead(result, projectorBlockRange)) return;
  }
  throw new Error("Invoice projection did not reach the chain head within 100 batches");
};
const app = createApp({
  authenticate: (request) => walletAuth.authenticate(request.headers.authorization),
  walletAuth,
  invoiceEnvelopes: database.invoiceEnvelopes,
  encryptionKeys: database.encryptionKeys,
  invoiceProjection: projection,
  readiness: async () => {
    if (serverless) await syncProjection().catch(() => undefined);
    return operationalMonitor.snapshot();
  },
  ...(serverless ? { refreshInvoiceProjection: syncProjectionToHead } : {}),
  requestPathPrefix: process.env.QUIETPACT_API_PATH_PREFIX ?? (serverless ? "/api" : ""),
});
const projectorTimer = serverless
  ? null
  : setInterval(() => void syncProjection().catch(() => undefined), 10_000);
projectorTimer?.unref();
app.addHook("onClose", () => {
  if (projectorTimer !== null) clearInterval(projectorTimer);
  database.close();
});

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

try {
  const host = process.env.QUIETPACT_API_HOST ?? (serverless ? "0.0.0.0" : "127.0.0.1");
  await app.listen({ host, port });
  await syncProjectionOnStartup(serverless, syncProjection);
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
