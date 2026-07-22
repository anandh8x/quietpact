import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { address, type Address } from "@quietpact/domain";
import type { SealedEnvelope } from "@quietpact/envelope";

import {
  InvoiceEnvelopeConflictError,
  type EncryptionKeyRepository,
  type InvoiceEnvelopeRepository,
  type PublishedEncryptionKey,
} from "./app.js";
import type { StoredWalletChallenge, StoredWalletSession, WalletAuthStore } from "./wallet-auth.js";

export interface QuietPactDatabase {
  readonly invoiceEnvelopes: InvoiceEnvelopeRepository;
  readonly encryptionKeys: EncryptionKeyRepository;
  readonly walletAuth: WalletAuthStore;
  close(): void;
}

export function openQuietPactDatabase(databasePath: string): QuietPactDatabase {
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS invoice_envelopes (
      id TEXT PRIMARY KEY,
      envelope_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS encryption_keys (
      id TEXT PRIMARY KEY,
      public_key TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_challenges (
      nonce TEXT PRIMARY KEY,
      actor TEXT NOT NULL,
      message TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      actor TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);

  const putEnvelope = database.prepare(
    "INSERT OR IGNORE INTO invoice_envelopes (id, envelope_json) VALUES (?, ?)",
  );
  const getEnvelope = database.prepare("SELECT envelope_json FROM invoice_envelopes WHERE id = ?");
  const putKey = database.prepare(`
    INSERT INTO encryption_keys (id, public_key) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET public_key = excluded.public_key
  `);
  const getKey = database.prepare("SELECT public_key FROM encryption_keys WHERE id = ?");
  const putChallenge = database.prepare(`
    INSERT INTO auth_challenges (nonce, actor, message, expires_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(nonce) DO UPDATE SET
      actor = excluded.actor,
      message = excluded.message,
      expires_at = excluded.expires_at
  `);
  const getChallenge = database.prepare(
    "SELECT actor, message, expires_at FROM auth_challenges WHERE nonce = ?",
  );
  const deleteChallenge = database.prepare("DELETE FROM auth_challenges WHERE nonce = ?");
  const putSession = database.prepare(`
    INSERT INTO auth_sessions (token_hash, actor, expires_at) VALUES (?, ?, ?)
    ON CONFLICT(token_hash) DO UPDATE SET
      actor = excluded.actor,
      expires_at = excluded.expires_at
  `);
  const getSession = database.prepare(
    "SELECT actor, expires_at FROM auth_sessions WHERE token_hash = ?",
  );
  const deleteSession = database.prepare("DELETE FROM auth_sessions WHERE token_hash = ?");
  const pruneChallenges = database.prepare("DELETE FROM auth_challenges WHERE expires_at <= ?");
  const pruneSessions = database.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?");

  return {
    invoiceEnvelopes: {
      put(id, envelope) {
        const key = id.toLowerCase();
        const serialized = JSON.stringify(envelope);
        const result = putEnvelope.run(key, serialized);
        if (result.changes === 0) {
          const existing = getEnvelope.get(key);
          if (existing === undefined || requiredString(existing, "envelope_json") !== serialized) {
            return Promise.reject(
              new InvoiceEnvelopeConflictError("Invoice envelope is already stored"),
            );
          }
        }
        return Promise.resolve(`invoice-envelope:${id}`);
      },
      get(id) {
        const row = getEnvelope.get(id.toLowerCase());
        if (row === undefined) return Promise.resolve(null);
        return Promise.resolve(parseEnvelope(requiredString(row, "envelope_json")));
      },
    },
    encryptionKeys: {
      put(key) {
        putKey.run(key.id, key.publicKey);
        return Promise.resolve();
      },
      get(id) {
        const row = getKey.get(id);
        if (row === undefined) return Promise.resolve(null);
        const key: PublishedEncryptionKey = {
          id,
          publicKey: requiredString(row, "public_key"),
        };
        return Promise.resolve(key);
      },
    },
    walletAuth: {
      putChallenge(nonce, challenge) {
        putChallenge.run(nonce, challenge.actor, challenge.message, challenge.expiresAt);
      },
      takeChallenge(nonce) {
        database.exec("BEGIN IMMEDIATE");
        try {
          const row = getChallenge.get(nonce);
          deleteChallenge.run(nonce);
          database.exec("COMMIT");
          return row === undefined ? null : parseChallenge(row);
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      },
      putSession(tokenHash, session) {
        putSession.run(tokenHash, session.actor, session.expiresAt);
      },
      getSession(tokenHash) {
        const row = getSession.get(tokenHash);
        return row === undefined ? null : parseSession(row);
      },
      deleteSession(tokenHash) {
        deleteSession.run(tokenHash);
      },
      pruneExpired(timestamp) {
        pruneChallenges.run(timestamp);
        pruneSessions.run(timestamp);
      },
    },
    close() {
      database.close();
    },
  };
}

function parseEnvelope(value: string): SealedEnvelope {
  const parsed: unknown = JSON.parse(value);
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("version" in parsed) ||
    parsed.version !== 1 ||
    !("wrappedKeys" in parsed) ||
    !Array.isArray(parsed.wrappedKeys)
  ) {
    throw new Error("Stored encrypted invoice is invalid");
  }
  return parsed as SealedEnvelope;
}

function parseChallenge(row: object): StoredWalletChallenge {
  return {
    actor: parseStoredAddress(row, "actor"),
    message: requiredString(row, "message"),
    expiresAt: requiredNumber(row, "expires_at"),
  };
}

function parseSession(row: object): StoredWalletSession {
  return {
    actor: parseStoredAddress(row, "actor"),
    expiresAt: requiredNumber(row, "expires_at"),
  };
}

function parseStoredAddress(row: object, key: string): Address {
  return address(requiredString(row, key));
}

function requiredString(row: object, key: string): string {
  const value = Reflect.get(row, key) as unknown;
  if (typeof value !== "string") throw new Error(`Database column ${key} is invalid`);
  return value;
}

function requiredNumber(row: object, key: string): number {
  const value = Reflect.get(row, key) as unknown;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Database column ${key} is invalid`);
  }
  return value;
}
