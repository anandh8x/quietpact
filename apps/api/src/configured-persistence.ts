import { fileURLToPath } from "node:url";

import { openQuietPactDatabase, type QuietPactDatabase } from "./persistence.js";
import { openTursoQuietPactDatabase } from "./turso-persistence.js";

export async function openConfiguredQuietPactDatabase(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<QuietPactDatabase> {
  const tursoUrl = environment.TURSO_DATABASE_URL?.trim();
  if (tursoUrl !== undefined && tursoUrl !== "") {
    return openTursoQuietPactDatabase({
      url: tursoUrl,
      authToken: environment.TURSO_AUTH_TOKEN ?? "",
    });
  }
  if (environment.VERCEL === "1") {
    throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required on Vercel");
  }

  const databasePath =
    environment.QUIETPACT_DATABASE_PATH ??
    fileURLToPath(new URL("../../../.quietpact-data/quietpact.sqlite", import.meta.url));
  return openQuietPactDatabase(databasePath);
}
