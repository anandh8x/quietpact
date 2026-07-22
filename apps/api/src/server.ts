import { address } from "@quietpact/domain";

import { createApp, createInMemoryInvoiceEnvelopeRepository } from "./app.js";

const port = Number(process.env.QUIETPACT_API_PORT ?? 3001);
const app = createApp({
  // Development-only identity adapter. Phase 4 replaces this with wallet-signed sessions.
  authenticate: (request) => address(String(request.headers["x-quietpact-dev-wallet"])),
  invoiceEnvelopes: createInMemoryInvoiceEnvelopeRepository(),
});

try {
  await app.listen({ host: "127.0.0.1", port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
