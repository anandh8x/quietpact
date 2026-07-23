import { chmodSync, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export async function backupDatabase(sourcePath, destinationPath) {
  return copyValidatedDatabase(sourcePath, destinationPath, "backup");
}

export async function restoreDatabase(backupPath, destinationPath) {
  return copyValidatedDatabase(backupPath, destinationPath, "restore");
}

async function copyValidatedDatabase(sourceInput, destinationInput, operation) {
  const sourcePath = resolveRequiredPath(sourceInput, `${operation} source`);
  const destinationPath = resolveRequiredPath(destinationInput, `${operation} destination`);
  if (sourcePath === destinationPath) {
    throw new Error(`Database ${operation} source and destination must be different`);
  }
  if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
    throw new Error(`Database ${operation} source does not exist: ${sourcePath}`);
  }
  if (existsSync(destinationPath)) {
    throw new Error(`Database ${operation} destination already exists: ${destinationPath}`);
  }

  mkdirSync(dirname(destinationPath), { recursive: true });
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    assertIntegrity(source, sourcePath);
    await backup(source, destinationPath);
    chmodSync(destinationPath, 0o600);
    const copied = new DatabaseSync(destinationPath, { readOnly: true });
    try {
      assertIntegrity(copied, destinationPath);
    } finally {
      copied.close();
    }
  } catch (error) {
    if (existsSync(destinationPath)) unlinkSync(destinationPath);
    throw error;
  } finally {
    source.close();
  }

  return Object.freeze({ sourcePath, destinationPath });
}

function assertIntegrity(database, databasePath) {
  const result = database.prepare("PRAGMA integrity_check").get();
  if (
    result === undefined ||
    typeof result.integrity_check !== "string" ||
    result.integrity_check !== "ok"
  ) {
    throw new Error(`SQLite integrity check failed: ${databasePath}`);
  }
}

function resolveRequiredPath(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Database ${label} path is required`);
  }
  return resolve(value);
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  const [, , operation, sourcePath, destinationPath] = process.argv;
  try {
    const result =
      operation === "backup"
        ? await backupDatabase(sourcePath, destinationPath)
        : operation === "restore"
          ? await restoreDatabase(sourcePath, destinationPath)
          : null;
    if (result === null) {
      throw new Error(
        "Usage: database-snapshot.mjs <backup|restore> <source.sqlite> <destination.sqlite>",
      );
    }
    process.stdout.write(
      `${operation === "backup" ? "Backup" : "Restore"} verified: ${result.destinationPath}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
