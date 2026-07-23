import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { address } from "@quietpact/domain";
import { afterEach, describe, expect, it } from "vitest";

import { backupDatabase, restoreDatabase } from "../../../scripts/database-snapshot.mjs";
import { openQuietPactDatabase } from "../src/persistence.js";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("SQLite backup and restore drill", () => {
  it("recovers QuietPact state into a new integrity-checked database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quietpact-restore-drill-"));
    temporaryDirectories.push(directory);
    const livePath = join(directory, "live.sqlite");
    const backupPath = join(directory, "backups", "snapshot.sqlite");
    const restoredPath = join(directory, "restored.sqlite");
    const actor = address("0x1000000000000000000000000000000000000001");
    const publicKey = "A".repeat(44);
    const live = openQuietPactDatabase(livePath);
    await live.encryptionKeys.put({ id: actor, publicKey });
    await live.walletAuth.putChallenge("restore-drill-nonce", {
      actor,
      message: "QuietPact restore drill",
      expiresAt: Date.parse("2026-07-24T00:00:00.000Z"),
    });

    await backupDatabase(livePath, backupPath);
    live.close();
    await restoreDatabase(backupPath, restoredPath);

    const restored = openQuietPactDatabase(restoredPath);
    await expect(restored.encryptionKeys.get(actor)).resolves.toEqual({ id: actor, publicKey });
    await expect(restored.walletAuth.takeChallenge("restore-drill-nonce")).resolves.toMatchObject({
      actor,
      message: "QuietPact restore drill",
    });
    restored.close();
    expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
    expect((await stat(restoredPath)).mode & 0o777).toBe(0o600);
  });

  it("refuses to overwrite an existing restore target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quietpact-restore-refusal-"));
    temporaryDirectories.push(directory);
    const livePath = join(directory, "live.sqlite");
    const backupPath = join(directory, "snapshot.sqlite");
    const restoredPath = join(directory, "restored.sqlite");
    openQuietPactDatabase(livePath).close();

    await backupDatabase(livePath, backupPath);
    await restoreDatabase(backupPath, restoredPath);

    await expect(restoreDatabase(backupPath, restoredPath)).rejects.toThrow(
      "restore destination already exists",
    );
  });
});
