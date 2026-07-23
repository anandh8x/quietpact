import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { createOperationalMonitor } from "../src/operational-monitor.js";

describe("privacy-safe operational readiness", () => {
  it("reports startup, bounded degradation, and recovery without workflow metadata", () => {
    let clock = Date.parse("2026-07-23T12:00:00.000Z");
    const monitor = createOperationalMonitor({
      checkDatabase: () => undefined,
      databaseSchemaVersion: 3,
      projectorDisabled: false,
      now: () => clock,
    });

    expect(monitor.snapshot()).toMatchObject({
      status: "starting",
      database: "ok",
      projector: "starting",
      consecutiveProjectorFailures: 0,
      lastProjectorSuccessAt: null,
    });

    clock += 1_000;
    monitor.projectorSucceeded();
    expect(monitor.snapshot()).toMatchObject({
      status: "ready",
      projector: "ok",
      lastProjectorSuccessAt: "2026-07-23T12:00:01.000Z",
      uptimeSeconds: 1,
    });

    monitor.projectorFailed();
    monitor.projectorFailed();
    expect(monitor.snapshot()).toMatchObject({
      status: "ready",
      projector: "degraded",
      consecutiveProjectorFailures: 2,
    });

    monitor.projectorFailed();
    const degraded = monitor.snapshot();
    expect(degraded).toMatchObject({
      status: "degraded",
      projector: "degraded",
      consecutiveProjectorFailures: 3,
    });
    expect(JSON.stringify(degraded)).not.toMatch(/address|invoice|auction|transaction|rpc/i);

    monitor.projectorSucceeded();
    expect(monitor.snapshot()).toMatchObject({
      status: "ready",
      projector: "ok",
      consecutiveProjectorFailures: 0,
    });
  });

  it("reports database failure without exposing its error", () => {
    const monitor = createOperationalMonitor({
      checkDatabase: () => {
        throw new Error("DATABASE_PATH_PRIVACY_CANARY_4f72");
      },
      databaseSchemaVersion: 3,
      projectorDisabled: true,
    });

    const report = monitor.snapshot();
    expect(report).toMatchObject({
      status: "degraded",
      database: "degraded",
      projector: "disabled",
    });
    expect(JSON.stringify(report)).not.toContain("DATABASE_PATH_PRIVACY_CANARY_4f72");
  });

  it("uses readiness status as the public HTTP availability signal", async () => {
    const starting = createApp({
      readiness: () => ({
        name: "quietpact-api",
        status: "starting",
        database: "ok",
        databaseSchemaVersion: 3,
        projector: "starting",
        consecutiveProjectorFailures: 0,
        lastProjectorSuccessAt: null,
        uptimeSeconds: 0,
      }),
      logger: false,
    });
    const response = await starting.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "starting",
      database: "ok",
      projector: "starting",
    });
    await starting.close();
  });
});
