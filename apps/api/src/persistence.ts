import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { address, type Address } from "@quietpact/domain";
import type { SealedEnvelope } from "@quietpact/envelope";
import type {
  InvoiceProjectionRepository,
  PublicInvoiceProjection,
} from "@quietpact/chain-records";

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
  invoiceProjection(scope: string): InvoiceProjectionRepository;
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
    CREATE TABLE IF NOT EXISTS invoice_projection (
      scope TEXT NOT NULL,
      id TEXT NOT NULL,
      payer TEXT NOT NULL,
      payee TEXT NOT NULL,
      commitment TEXT NOT NULL,
      ciphertext_hash TEXT NOT NULL,
      state TEXT NOT NULL,
      created_transaction_hash TEXT NOT NULL,
      latest_transaction_hash TEXT NOT NULL,
      latest_block TEXT NOT NULL,
      PRIMARY KEY (scope, id)
    );
    CREATE TABLE IF NOT EXISTS projector_cursors (
      scope TEXT PRIMARY KEY,
      through_block TEXT NOT NULL,
      through_hash TEXT NOT NULL
    );
  `);
  const cursorColumns = database.prepare("PRAGMA table_info(projector_cursors)").all();
  if (!cursorColumns.some((column) => requiredString(column, "name") === "through_hash")) {
    database.exec(`
      ALTER TABLE projector_cursors ADD COLUMN through_hash TEXT NOT NULL
      DEFAULT '0x0000000000000000000000000000000000000000000000000000000000000000'
    `);
  }
  database.exec(`
    UPDATE projector_cursors
    SET through_hash = '0x0000000000000000000000000000000000000000000000000000000000000000'
    WHERE through_hash = '0x'
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
  const getProjectionCursor = database.prepare(
    "SELECT through_block, through_hash FROM projector_cursors WHERE scope = ?",
  );
  const putProjectionCursor = database.prepare(`
    INSERT INTO projector_cursors (scope, through_block, through_hash) VALUES (?, ?, ?)
    ON CONFLICT(scope) DO UPDATE SET
      through_block = excluded.through_block,
      through_hash = excluded.through_hash
  `);
  const insertProjection = database.prepare(`
    INSERT OR IGNORE INTO invoice_projection (
      scope, id, payer, payee, commitment, ciphertext_hash, state,
      created_transaction_hash, latest_transaction_hash, latest_block
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateProjectionState = database.prepare(`
    UPDATE invoice_projection
    SET state = ?, latest_transaction_hash = ?, latest_block = ?
    WHERE scope = ? AND id = ?
  `);
  const getProjection = database.prepare(`
    SELECT id, payer, payee, commitment, ciphertext_hash, state,
      created_transaction_hash, latest_transaction_hash, latest_block
    FROM invoice_projection WHERE scope = ? AND id = ?
  `);
  const clearProjection = database.prepare("DELETE FROM invoice_projection WHERE scope = ?");

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
    invoiceProjection(scope) {
      return {
        cursor() {
          const row = getProjectionCursor.get(scope);
          return Promise.resolve(
            row === undefined
              ? null
              : {
                  blockNumber: BigInt(requiredString(row, "through_block")),
                  blockHash: requiredHex(row, "through_hash"),
                },
          );
        },
        apply(batch) {
          database.exec("BEGIN IMMEDIATE");
          try {
            if (batch.reset) clearProjection.run(scope);
            for (const event of batch.events) {
              if (event.type === "created") {
                const invoice = event.invoice;
                const result = insertProjection.run(
                  scope,
                  invoice.id,
                  invoice.payer,
                  invoice.payee,
                  invoice.commitment,
                  invoice.ciphertextHash,
                  invoice.state,
                  invoice.createdTransactionHash,
                  invoice.latestTransactionHash,
                  invoice.latestBlock.toString(),
                );
                if (result.changes === 0) {
                  const existing = getProjection.get(scope, invoice.id);
                  if (existing === undefined || !sameCreatedProjection(existing, invoice)) {
                    throw new Error("Conflicting InvoiceCreated event in projection");
                  }
                }
              } else {
                const result = updateProjectionState.run(
                  event.state,
                  event.transactionHash,
                  event.blockNumber.toString(),
                  scope,
                  event.id,
                );
                if (result.changes === 0) {
                  throw new Error("Invoice state event has no projected invoice");
                }
              }
            }
            putProjectionCursor.run(scope, batch.throughBlock.toString(), batch.throughBlockHash);
            database.exec("COMMIT");
            return Promise.resolve();
          } catch (error) {
            database.exec("ROLLBACK");
            return Promise.reject(
              error instanceof Error
                ? error
                : new Error("Invoice projection batch failed", { cause: error }),
            );
          }
        },
        view(id) {
          const row = getProjection.get(scope, id);
          return Promise.resolve(row === undefined ? null : parseProjection(row));
        },
      };
    },
    close() {
      database.close();
    },
  };
}

function parseProjection(row: object): PublicInvoiceProjection {
  return {
    id: requiredHex(row, "id"),
    payer: parseStoredAddress(row, "payer"),
    payee: parseStoredAddress(row, "payee"),
    commitment: requiredHex(row, "commitment"),
    ciphertextHash: requiredHex(row, "ciphertext_hash"),
    state: requiredInvoiceState(row, "state"),
    createdTransactionHash: requiredHex(row, "created_transaction_hash"),
    latestTransactionHash: requiredHex(row, "latest_transaction_hash"),
    latestBlock: BigInt(requiredString(row, "latest_block")),
  };
}

function sameCreatedProjection(row: object, invoice: PublicInvoiceProjection): boolean {
  return (
    requiredString(row, "payer") === invoice.payer &&
    requiredString(row, "payee") === invoice.payee &&
    requiredString(row, "commitment") === invoice.commitment &&
    requiredString(row, "ciphertext_hash") === invoice.ciphertextHash &&
    requiredString(row, "created_transaction_hash") === invoice.createdTransactionHash
  );
}

function requiredHex(row: object, key: string): `0x${string}` {
  const value = requiredString(row, key);
  if (!/^0x[0-9a-f]+$/i.test(value)) throw new Error(`Database column ${key} is invalid`);
  return value as `0x${string}`;
}

function requiredInvoiceState(row: object, key: string): PublicInvoiceProjection["state"] {
  const value = requiredString(row, key);
  if (
    value !== "REGISTERED" &&
    value !== "APPROVED" &&
    value !== "PAYMENT_REFERENCED" &&
    value !== "COMPLETE" &&
    value !== "DISPUTED" &&
    value !== "CANCELLED"
  ) {
    throw new Error(`Database column ${key} is invalid`);
  }
  return value;
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
