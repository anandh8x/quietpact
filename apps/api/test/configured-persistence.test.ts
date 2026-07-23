import { describe, expect, it } from "vitest";

import { openConfiguredQuietPactDatabase } from "../src/configured-persistence.js";

describe("configured persistence", () => {
  it("keeps local SQLite as the development adapter", async () => {
    const database = await openConfiguredQuietPactDatabase({
      QUIETPACT_DATABASE_PATH: ":memory:",
    });

    await expect(database.checkHealth()).resolves.toBeUndefined();
    database.close();
  });

  it("refuses ephemeral Vercel persistence", async () => {
    await expect(openConfiguredQuietPactDatabase({ VERCEL: "1" })).rejects.toThrow(
      "TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required on Vercel",
    );
  });

  it("requires both Turso credentials", async () => {
    await expect(
      openConfiguredQuietPactDatabase({
        TURSO_DATABASE_URL: "libsql://quietpact.example.turso.io",
      }),
    ).rejects.toThrow("TURSO_AUTH_TOKEN is required");
  });
});
