import { describe, expect, it } from "vitest";

import { createArcSmokeSchedule } from "./arc-smoke-schedule.mjs";

describe("Arc smoke auction schedule", () => {
  it("leaves enough submission time before the commit window opens", () => {
    const latestTimestamp = 1_000;
    const schedule = createArcSmokeSchedule(latestTimestamp);

    expect(schedule.commitOpensAt - latestTimestamp).toBeGreaterThanOrEqual(60);
    expect(schedule.revealOpensAt).toBeGreaterThan(schedule.commitOpensAt);
    expect(schedule.revealClosesAt).toBeGreaterThan(schedule.revealOpensAt);
  });
});
