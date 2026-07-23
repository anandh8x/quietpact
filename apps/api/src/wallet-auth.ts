import { createHash, randomBytes } from "node:crypto";

import { type Address } from "@quietpact/domain";
import { verifyMessage, type Hex } from "viem";

export interface WalletChallenge {
  readonly nonce: string;
  readonly message: string;
  readonly expiresAt: string;
}

export interface WalletSession {
  readonly token: string;
  readonly expiresAt: string;
}

export interface WalletAuth {
  issueChallenge(actor: Address): Promise<WalletChallenge>;
  createSession(input: {
    readonly actor: Address;
    readonly nonce: string;
    readonly signature: Hex;
  }): Promise<WalletSession>;
  authenticate(authorization: string | undefined): Promise<Address>;
}

export interface StoredWalletChallenge {
  readonly actor: Address;
  readonly message: string;
  readonly expiresAt: number;
}

export interface StoredWalletSession {
  readonly actor: Address;
  readonly expiresAt: number;
}

export interface WalletAuthStore {
  putChallenge(nonce: string, challenge: StoredWalletChallenge): Promise<void>;
  takeChallenge(nonce: string): Promise<StoredWalletChallenge | null>;
  putSession(tokenHash: string, session: StoredWalletSession): Promise<void>;
  getSession(tokenHash: string): Promise<StoredWalletSession | null>;
  deleteSession(tokenHash: string): Promise<void>;
  pruneExpired(now: number): Promise<void>;
}

export type WalletAuthErrorCode =
  "AUTH_REQUIRED" | "CHALLENGE_EXPIRED" | "CHALLENGE_NOT_FOUND" | "INVALID_SIGNATURE";

export class WalletAuthError extends Error {
  override readonly name = "WalletAuthError";

  constructor(
    readonly code: WalletAuthErrorCode,
    readonly statusCode: 401 | 404,
    message: string,
  ) {
    super(message);
  }
}

export function createInMemoryWalletAuth(options?: {
  readonly now?: () => number;
  readonly challengeLifetimeMs?: number;
  readonly sessionLifetimeMs?: number;
  readonly authenticationOrigin?: string;
  readonly chainId?: string;
}): WalletAuth {
  return createWalletAuth(createInMemoryWalletAuthStore(), options);
}

export function createWalletAuth(
  store: WalletAuthStore,
  options?: {
    readonly now?: () => number;
    readonly challengeLifetimeMs?: number;
    readonly sessionLifetimeMs?: number;
    readonly authenticationOrigin?: string;
    readonly chainId?: string;
  },
): WalletAuth {
  const now = options?.now ?? Date.now;
  const challengeLifetimeMs = options?.challengeLifetimeMs ?? 5 * 60 * 1000;
  const sessionLifetimeMs = options?.sessionLifetimeMs ?? 30 * 60 * 1000;
  const authenticationOrigin = options?.authenticationOrigin ?? "local development";
  const chainId = options?.chainId ?? "31337";

  return {
    async issueChallenge(actor) {
      await store.pruneExpired(now());
      const nonce = randomBytes(16).toString("hex");
      const expiresAt = now() + challengeLifetimeMs;
      const message = challengeMessage(actor, nonce, expiresAt, authenticationOrigin, chainId);
      await store.putChallenge(nonce, { actor, message, expiresAt });
      return { nonce, message, expiresAt: new Date(expiresAt).toISOString() };
    },

    async createSession(input) {
      const challenge = await store.takeChallenge(input.nonce);
      if (challenge === null || challenge.actor !== input.actor) {
        throw new WalletAuthError("CHALLENGE_NOT_FOUND", 404, "Wallet challenge was not found");
      }
      if (challenge.expiresAt <= now()) {
        throw new WalletAuthError("CHALLENGE_EXPIRED", 401, "Wallet challenge has expired");
      }

      let valid = false;
      try {
        valid = await verifyMessage({
          address: input.actor,
          message: challenge.message,
          signature: input.signature,
        });
      } catch {
        valid = false;
      }
      if (!valid) {
        throw new WalletAuthError("INVALID_SIGNATURE", 401, "Wallet signature is invalid");
      }

      const token = randomBytes(32).toString("base64url");
      const expiresAt = now() + sessionLifetimeMs;
      await store.putSession(hashToken(token), { actor: input.actor, expiresAt });
      return { token, expiresAt: new Date(expiresAt).toISOString() };
    },

    async authenticate(authorization) {
      await store.pruneExpired(now());
      const token = parseBearerToken(authorization);
      const tokenHash = token === null ? null : hashToken(token);
      const session = tokenHash === null ? null : await store.getSession(tokenHash);
      if (session === null || session.expiresAt <= now()) {
        if (tokenHash !== null) await store.deleteSession(tokenHash);
        throw new WalletAuthError("AUTH_REQUIRED", 401, "A valid wallet session is required");
      }
      return session.actor;
    },
  };
}

export function createInMemoryWalletAuthStore(): WalletAuthStore {
  const challenges = new Map<string, StoredWalletChallenge>();
  const sessions = new Map<string, StoredWalletSession>();

  return {
    putChallenge(nonce, challenge) {
      challenges.set(nonce, challenge);
      return Promise.resolve();
    },
    takeChallenge(nonce) {
      const challenge = challenges.get(nonce) ?? null;
      challenges.delete(nonce);
      return Promise.resolve(challenge);
    },
    putSession(tokenHash, session) {
      sessions.set(tokenHash, session);
      return Promise.resolve();
    },
    getSession(tokenHash) {
      return Promise.resolve(sessions.get(tokenHash) ?? null);
    },
    deleteSession(tokenHash) {
      sessions.delete(tokenHash);
      return Promise.resolve();
    },
    pruneExpired(timestamp) {
      for (const [nonce, challenge] of challenges) {
        if (challenge.expiresAt <= timestamp) challenges.delete(nonce);
      }
      for (const [tokenHash, session] of sessions) {
        if (session.expiresAt <= timestamp) sessions.delete(tokenHash);
      }
      return Promise.resolve();
    },
  };
}

function challengeMessage(
  actor: Address,
  nonce: string,
  expiresAt: number,
  authenticationOrigin: string,
  chainId: string,
): string {
  return [
    "QuietPact authentication",
    "",
    `Origin: ${authenticationOrigin}`,
    `Chain ID: ${chainId}`,
    `Wallet: ${actor}`,
    `Nonce: ${nonce}`,
    `Expires: ${new Date(expiresAt).toISOString()}`,
    "Purpose: authenticate API access only; no transaction or payment.",
  ].join("\n");
}

function parseBearerToken(value: string | undefined): string | null {
  if (value === undefined) return null;
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(value);
  return match?.[1] ?? null;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
