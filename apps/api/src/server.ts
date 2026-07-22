import { fileURLToPath } from "node:url";

import { createApp } from "./app.js";
import { openQuietPactDatabase } from "./persistence.js";
import { createWalletAuth } from "./wallet-auth.js";

const port = Number(process.env.QUIETPACT_API_PORT ?? 3001);
const databasePath =
  process.env.QUIETPACT_DATABASE_PATH ??
  fileURLToPath(new URL("../../../.quietpact-data/quietpact.sqlite", import.meta.url));
const database = openQuietPactDatabase(databasePath);
const walletAuth = createWalletAuth(database.walletAuth);
const app = createApp({
  authenticate: (request) => walletAuth.authenticate(request.headers.authorization),
  walletAuth,
  invoiceEnvelopes: database.invoiceEnvelopes,
  encryptionKeys: database.encryptionKeys,
});
app.addHook("onClose", () => database.close());

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

try {
  await app.listen({ host: "127.0.0.1", port });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
