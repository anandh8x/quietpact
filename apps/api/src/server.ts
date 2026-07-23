import { fileURLToPath } from "node:url";

import { createViemInvoiceProjector } from "@quietpact/chain-records";
import { address } from "@quietpact/domain";
import { createPublicClient, http } from "viem";

import { createApp } from "./app.js";
import { openQuietPactDatabase } from "./persistence.js";
import { createWalletAuth } from "./wallet-auth.js";

const port = Number(process.env.QUIETPACT_API_PORT ?? 3001);
const databasePath =
  process.env.QUIETPACT_DATABASE_PATH ??
  fileURLToPath(new URL("../../../.quietpact-data/quietpact.sqlite", import.meta.url));
const database = openQuietPactDatabase(databasePath);
const walletAuth = createWalletAuth(database.walletAuth);
const chainId = process.env.QUIETPACT_CHAIN_ID ?? "31337";
const registry = address(
  process.env.QUIETPACT_REGISTRY_ADDRESS ?? "0x5FbDB2315678afecb367f032d93F642f64180aa3",
);
const projection = database.invoiceProjection(`${chainId}:${registry}`);
const app = createApp({
  authenticate: (request) => walletAuth.authenticate(request.headers.authorization),
  walletAuth,
  invoiceEnvelopes: database.invoiceEnvelopes,
  encryptionKeys: database.encryptionKeys,
  invoiceProjection: projection,
});
const projector = createViemInvoiceProjector({
  registry,
  publicClient: createPublicClient({
    transport: http(process.env.QUIETPACT_RPC_URL ?? "http://127.0.0.1:8545"),
  }),
  repository: projection,
  startBlock: BigInt(process.env.QUIETPACT_REGISTRY_START_BLOCK ?? "0"),
});
let projectorRunning = false;
const syncProjection = async () => {
  if (projectorRunning || process.env.QUIETPACT_PROJECTOR_DISABLED === "1") return;
  projectorRunning = true;
  try {
    const result = await projector.sync();
    if (result.events > 0) app.log.info(result, "invoice projection synchronized");
  } catch (error) {
    app.log.warn({ err: error }, "invoice projection synchronization failed");
  } finally {
    projectorRunning = false;
  }
};
const projectorTimer = setInterval(() => void syncProjection(), 10_000);
projectorTimer.unref();
app.addHook("onClose", () => {
  clearInterval(projectorTimer);
  database.close();
});

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

try {
  await app.listen({ host: "127.0.0.1", port });
  await syncProjection();
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
