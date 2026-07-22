import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../apps/api/src/app.js";

const apps: ReturnType<typeof createApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("API health", () => {
  it("reports a stable service identity", async () => {
    const app = createApp();
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ name: "quietpact-api", status: "ok" });
  });
});
