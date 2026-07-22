import {
  createApp,
  createInMemoryEncryptionKeyRepository,
  createInMemoryInvoiceEnvelopeRepository,
} from "./app.js";
import { createInMemoryWalletAuth } from "./wallet-auth.js";

const port = Number(process.env.QUIETPACT_API_PORT ?? 3001);
const walletAuth = createInMemoryWalletAuth();
const app = createApp({
  authenticate: (request) => walletAuth.authenticate(request.headers.authorization),
  walletAuth,
  invoiceEnvelopes: createInMemoryInvoiceEnvelopeRepository(),
  encryptionKeys: createInMemoryEncryptionKeyRepository(),
});

try {
  await app.listen({ host: "127.0.0.1", port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
