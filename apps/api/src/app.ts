import Fastify, { type FastifyInstance } from "fastify";

export function createApp(): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get("/health", () => ({
    name: "quietpact-api",
    status: "ok",
  }));

  return app;
}
