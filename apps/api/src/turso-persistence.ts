import { createClient, type Client, type InStatement } from "@libsql/client/web";

import type { PublicInvoiceProjection } from "@quietpact/chain-records";

import { InvoiceEnvelopeConflictError } from "./app.js";
import {
  parseChallenge,
  parseEnvelope,
  parseProjection,
  parseSession,
  QUIETPACT_DATABASE_SCHEMA_VERSION,
  requiredString,
  sameCreatedProjection,
  type QuietPactDatabase,
} from "./persistence.js";

export interface TursoDatabaseConfig {
  readonly url: string;
  readonly authToken: string;
}

export async function openTursoQuietPactDatabase(
  config: TursoDatabaseConfig,
): Promise<QuietPactDatabase> {
  const url = requiredConfig(config.url, "TURSO_DATABASE_URL");
  const authToken = requiredConfig(config.authToken, "TURSO_AUTH_TOKEN");
  if (!url.startsWith("libsql://") && !url.startsWith("https://")) {
    throw new Error("TURSO_DATABASE_URL must use libsql:// or https://");
  }
  const client = createClient({ url, authToken });
  try {
    return await createTursoQuietPactDatabase(client);
  } catch (error) {
    client.close();
    throw error;
  }
}

export async function createTursoQuietPactDatabase(client: Client): Promise<QuietPactDatabase> {
  await migrateTursoDatabase(client);

  return {
    schemaVersion: QUIETPACT_DATABASE_SCHEMA_VERSION,
    invoiceEnvelopes: {
      async put(id, envelope) {
        const key = id.toLowerCase();
        const serialized = JSON.stringify(envelope);
        const result = await client.execute({
          sql: "INSERT OR IGNORE INTO invoice_envelopes (id, envelope_json) VALUES (?, ?)",
          args: [key, serialized],
        });
        if (result.rowsAffected === 0) {
          const existing = await client.execute({
            sql: "SELECT envelope_json FROM invoice_envelopes WHERE id = ?",
            args: [key],
          });
          const row = existing.rows[0];
          if (row === undefined || requiredString(row, "envelope_json") !== serialized) {
            throw new InvoiceEnvelopeConflictError("Invoice envelope is already stored");
          }
        }
        return `invoice-envelope:${id}`;
      },
      async get(id) {
        const result = await client.execute({
          sql: "SELECT envelope_json FROM invoice_envelopes WHERE id = ?",
          args: [id.toLowerCase()],
        });
        const row = result.rows[0];
        return row === undefined ? null : parseEnvelope(requiredString(row, "envelope_json"));
      },
    },
    encryptionKeys: {
      async put(key) {
        await client.execute({
          sql: `
            INSERT INTO encryption_keys (id, public_key) VALUES (?, ?)
            ON CONFLICT(id) DO UPDATE SET public_key = excluded.public_key
          `,
          args: [key.id, key.publicKey],
        });
      },
      async get(id) {
        const result = await client.execute({
          sql: "SELECT public_key FROM encryption_keys WHERE id = ?",
          args: [id],
        });
        const row = result.rows[0];
        return row === undefined ? null : { id, publicKey: requiredString(row, "public_key") };
      },
    },
    walletAuth: {
      async putChallenge(nonce, challenge) {
        await client.execute({
          sql: `
            INSERT INTO auth_challenges (nonce, actor, message, expires_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(nonce) DO UPDATE SET
              actor = excluded.actor,
              message = excluded.message,
              expires_at = excluded.expires_at
          `,
          args: [nonce, challenge.actor, challenge.message, challenge.expiresAt],
        });
      },
      async takeChallenge(nonce) {
        const result = await client.execute({
          sql: `
            DELETE FROM auth_challenges
            WHERE nonce = ?
            RETURNING actor, message, expires_at
          `,
          args: [nonce],
        });
        const row = result.rows[0];
        return row === undefined ? null : parseChallenge(row);
      },
      async putSession(tokenHash, session) {
        await client.execute({
          sql: `
            INSERT INTO auth_sessions (token_hash, actor, expires_at) VALUES (?, ?, ?)
            ON CONFLICT(token_hash) DO UPDATE SET
              actor = excluded.actor,
              expires_at = excluded.expires_at
          `,
          args: [tokenHash, session.actor, session.expiresAt],
        });
      },
      async getSession(tokenHash) {
        const result = await client.execute({
          sql: "SELECT actor, expires_at FROM auth_sessions WHERE token_hash = ?",
          args: [tokenHash],
        });
        const row = result.rows[0];
        return row === undefined ? null : parseSession(row);
      },
      async deleteSession(tokenHash) {
        await client.execute({
          sql: "DELETE FROM auth_sessions WHERE token_hash = ?",
          args: [tokenHash],
        });
      },
      async pruneExpired(timestamp) {
        await client.batch(
          [
            {
              sql: "DELETE FROM auth_challenges WHERE expires_at <= ?",
              args: [timestamp],
            },
            {
              sql: "DELETE FROM auth_sessions WHERE expires_at <= ?",
              args: [timestamp],
            },
          ],
          "write",
        );
      },
    },
    invoiceProjection(scope) {
      return {
        async cursor() {
          const result = await client.execute({
            sql: `
              SELECT through_block, through_hash
              FROM projector_cursors
              WHERE scope = ?
            `,
            args: [scope],
          });
          const row = result.rows[0];
          return row === undefined
            ? null
            : {
                blockNumber: BigInt(requiredString(row, "through_block")),
                blockHash: requiredHex(row, "through_hash"),
              };
        },
        async apply(batch) {
          const transaction = await client.transaction("write");
          try {
            const storedCursor = await transaction.execute({
              sql: "SELECT through_block FROM projector_cursors WHERE scope = ?",
              args: [scope],
            });
            const storedCursorRow = storedCursor.rows[0];
            if (
              !batch.reset &&
              storedCursorRow !== undefined &&
              BigInt(requiredString(storedCursorRow, "through_block")) >= batch.throughBlock
            ) {
              await transaction.commit();
              return;
            }
            if (batch.reset) {
              await transaction.execute({
                sql: "DELETE FROM invoice_projection WHERE scope = ?",
                args: [scope],
              });
            }
            for (const event of batch.events) {
              if (event.type === "created") {
                await insertCreatedProjection(transaction, scope, event.invoice);
              } else if (event.type === "stateChanged") {
                const result = await transaction.execute({
                  sql: `
                    UPDATE invoice_projection
                    SET state = ?, latest_transaction_hash = ?, latest_block = ?
                    WHERE scope = ? AND id = ?
                  `,
                  args: [
                    event.state,
                    event.transactionHash,
                    event.blockNumber.toString(),
                    scope,
                    event.id,
                  ],
                });
                if (result.rowsAffected === 0) {
                  throw new Error("Invoice state event has no projected invoice");
                }
              } else {
                const result = await transaction.execute({
                  sql: `
                    UPDATE invoice_projection
                    SET public_payment_reference = ?, latest_transaction_hash = ?, latest_block = ?
                    WHERE scope = ? AND id = ?
                  `,
                  args: [
                    event.reference,
                    event.transactionHash,
                    event.blockNumber.toString(),
                    scope,
                    event.id,
                  ],
                });
                if (result.rowsAffected === 0) {
                  throw new Error("Public payment event has no projected invoice");
                }
              }
            }
            await transaction.execute({
              sql: `
                INSERT INTO projector_cursors (scope, through_block, through_hash)
                VALUES (?, ?, ?)
                ON CONFLICT(scope) DO UPDATE SET
                  through_block = excluded.through_block,
                  through_hash = excluded.through_hash
              `,
              args: [scope, batch.throughBlock.toString(), batch.throughBlockHash],
            });
            await transaction.commit();
          } catch (error) {
            if (!transaction.closed) await transaction.rollback();
            throw error instanceof Error
              ? error
              : new Error("Invoice projection batch failed", { cause: error });
          } finally {
            transaction.close();
          }
        },
        async view(id) {
          const result = await client.execute({
            sql: `
              SELECT id, payer, payee, commitment, ciphertext_hash, state,
                public_payment_reference, created_transaction_hash,
                latest_transaction_hash, latest_block
              FROM invoice_projection
              WHERE scope = ? AND id = ?
            `,
            args: [scope, id],
          });
          const row = result.rows[0];
          return row === undefined ? null : parseProjection(row);
        },
      };
    },
    async checkHealth() {
      const result = await client.execute("SELECT 1 AS healthy");
      const row = result.rows[0];
      if (row === undefined || row.healthy !== 1) {
        throw new Error("QuietPact database health check failed");
      }
    },
    close() {
      client.close();
    },
  };
}

async function insertCreatedProjection(
  transaction: Awaited<ReturnType<Client["transaction"]>>,
  scope: string,
  invoice: PublicInvoiceProjection,
): Promise<void> {
  const result = await transaction.execute({
    sql: `
      INSERT OR IGNORE INTO invoice_projection (
        scope, id, payer, payee, commitment, ciphertext_hash, state,
        public_payment_reference, created_transaction_hash, latest_transaction_hash, latest_block
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      scope,
      invoice.id,
      invoice.payer,
      invoice.payee,
      invoice.commitment,
      invoice.ciphertextHash,
      invoice.state,
      invoice.publicPaymentReference,
      invoice.createdTransactionHash,
      invoice.latestTransactionHash,
      invoice.latestBlock.toString(),
    ],
  });
  if (result.rowsAffected > 0) return;

  const existing = await transaction.execute({
    sql: `
      SELECT payer, payee, commitment, ciphertext_hash, created_transaction_hash
      FROM invoice_projection
      WHERE scope = ? AND id = ?
    `,
    args: [scope, invoice.id],
  });
  const row = existing.rows[0];
  if (row === undefined || !sameCreatedProjection(row, invoice)) {
    throw new Error("Conflicting InvoiceCreated event in projection");
  }
}

async function migrateTursoDatabase(client: Client): Promise<void> {
  await client.batch(
    [
      `
        CREATE TABLE IF NOT EXISTS quietpact_schema (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          version INTEGER NOT NULL
        )
      `,
      "INSERT OR IGNORE INTO quietpact_schema (singleton, version) VALUES (1, 0)",
    ],
    "write",
  );
  const versionResult = await client.execute(
    "SELECT version FROM quietpact_schema WHERE singleton = 1",
  );
  const currentVersion = requiredVersion(versionResult.rows[0]);
  if (currentVersion > QUIETPACT_DATABASE_SCHEMA_VERSION) {
    throw new Error(
      `QuietPact database schema ${String(currentVersion)} is newer than supported schema ${String(QUIETPACT_DATABASE_SCHEMA_VERSION)}`,
    );
  }
  if (currentVersion === QUIETPACT_DATABASE_SCHEMA_VERSION) return;
  if (currentVersion !== 0) {
    throw new Error(
      `QuietPact Turso database schema ${String(currentVersion)} requires an explicit migration`,
    );
  }

  const statements: InStatement[] = [
    `
      CREATE TABLE IF NOT EXISTS invoice_envelopes (
        id TEXT PRIMARY KEY,
        envelope_json TEXT NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS encryption_keys (
        id TEXT PRIMARY KEY,
        public_key TEXT NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS auth_challenges (
        nonce TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        message TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS invoice_projection (
        scope TEXT NOT NULL,
        id TEXT NOT NULL,
        payer TEXT NOT NULL,
        payee TEXT NOT NULL,
        commitment TEXT NOT NULL,
        ciphertext_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        public_payment_reference TEXT,
        created_transaction_hash TEXT NOT NULL,
        latest_transaction_hash TEXT NOT NULL,
        latest_block TEXT NOT NULL,
        PRIMARY KEY (scope, id)
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS projector_cursors (
        scope TEXT PRIMARY KEY,
        through_block TEXT NOT NULL,
        through_hash TEXT NOT NULL
      )
    `,
    {
      sql: "UPDATE quietpact_schema SET version = ? WHERE singleton = 1",
      args: [QUIETPACT_DATABASE_SCHEMA_VERSION],
    },
  ];
  await client.migrate(statements);
}

function requiredVersion(row: object | undefined): number {
  if (row === undefined) throw new Error("QuietPact Turso schema metadata is missing");
  const value = Reflect.get(row, "version") as unknown;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("QuietPact Turso schema version is invalid");
  }
  return value;
}

function requiredHex(row: object, key: string): `0x${string}` {
  const value = requiredString(row, key);
  if (!/^0x[0-9a-f]+$/i.test(value)) throw new Error(`Database column ${key} is invalid`);
  return value as `0x${string}`;
}

function requiredConfig(value: string, name: string): string {
  const trimmed = value.trim();
  if (trimmed === "") throw new Error(`${name} is required`);
  return trimmed;
}
