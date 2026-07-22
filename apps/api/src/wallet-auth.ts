import { randomBytes } from "node:crypto";

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
  issueChallenge(actor: Address): WalletChallenge;
  createSession(input: {
    readonly actor: Address;
    readonly nonce: string;
    readonly signature: Hex;
  }): Promise<WalletSession>;
  authenticate(authorization: string | undefined): Address;
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
}): WalletAuth {
  const now = options?.now ?? Date.now;
  const challengeLifetimeMs = options?.challengeLifetimeMs ?? 5 * 60 * 1000;
  const sessionLifetimeMs = options?.sessionLifetimeMs ?? 30 * 60 * 1000;
  const challenges = new Map<
    string,
    Readonly<{ actor: Address; message: string; expiresAt: number }>
  >();
  const sessions = new Map<string, Readonly<{ actor: Address; expiresAt: number }>>();

  return {
    issueChallenge(actor) {
      const nonce = randomBytes(16).toString("hex");
      const expiresAt = now() + challengeLifetimeMs;
      const message = challengeMessage(actor, nonce, expiresAt);
      challenges.set(nonce, { actor, message, expiresAt });
      return { nonce, message, expiresAt: new Date(expiresAt).toISOString() };
    },

    async createSession(input) {
      const challenge = challenges.get(input.nonce);
      if (challenge === undefined || challenge.actor !== input.actor) {
        throw new WalletAuthError("CHALLENGE_NOT_FOUND", 404, "Wallet challenge was not found");
      }
      challenges.delete(input.nonce);
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
      sessions.set(token, { actor: input.actor, expiresAt });
      return { token, expiresAt: new Date(expiresAt).toISOString() };
    },

    authenticate(authorization) {
      const token = parseBearerToken(authorization);
      const session = token === null ? undefined : sessions.get(token);
      if (session === undefined || session.expiresAt <= now()) {
        if (token !== null) sessions.delete(token);
        throw new WalletAuthError("AUTH_REQUIRED", 401, "A valid wallet session is required");
      }
      return session.actor;
    },
  };
}

function challengeMessage(actor: Address, nonce: string, expiresAt: number): string {
  return [
    "QuietPact local authentication",
    "",
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
