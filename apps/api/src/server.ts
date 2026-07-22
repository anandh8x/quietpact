import { createApp } from "./app.js";

const port = Number(process.env.QUIETPACT_API_PORT ?? 3001);
const app = createApp();

try {
  await app.listen({ host: "127.0.0.1", port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
