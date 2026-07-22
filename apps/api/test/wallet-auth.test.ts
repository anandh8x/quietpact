import { describe, expect, it } from "vitest";

import { address } from "@quietpact/domain";
import { privateKeyToAccount } from "viem/accounts";

import {
  createApp,
  createInMemoryEncryptionKeyRepository,
  createInMemoryInvoiceEnvelopeRepository,
} from "../src/app.js";
import { createInMemoryWalletAuth } from "../src/wallet-auth.js";

const owner = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const stranger = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

describe("wallet API authentication", () => {
  it("exchanges a one-time wallet signature for a bearer session", async () => {
    const auth = createInMemoryWalletAuth();
    const app = createApp({
      walletAuth: auth,
      authenticate: (request) => auth.authenticate(request.headers.authorization),
      encryptionKeys: createInMemoryEncryptionKeyRepository(),
      invoiceEnvelopes: createInMemoryInvoiceEnvelopeRepository(),
    });
    const challengeResponse = await app.inject({
      method: "POST",
      url: "/v1/auth/challenges",
      payload: { address: owner.address },
    });
    const challenge = challengeResponse.json<{
      challenge: { nonce: string; message: string };
    }>().challenge;
    const signature = await owner.signMessage({ message: challenge.message });
    const sessionResponse = await app.inject({
      method: "POST",
      url: "/v1/auth/sessions",
      payload: { address: owner.address, nonce: challenge.nonce, signature },
    });
    const token = sessionResponse.json<{ session: { token: string } }>().session.token;
    const protectedResponse = await app.inject({
      method: "PUT",
      url: `/v1/encryption-keys/${owner.address}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { publicKey: "A".repeat(44) },
    });
    const replayResponse = await app.inject({
      method: "POST",
      url: "/v1/auth/sessions",
      payload: { address: owner.address, nonce: challenge.nonce, signature },
    });
    const unauthenticatedEnvelope = await app.inject({
      method: "GET",
      url: `/v1/invoice-envelopes/0x${"12".repeat(32)}`,
    });
    const authenticatedEnvelope = await app.inject({
      method: "GET",
      url: `/v1/invoice-envelopes/0x${"12".repeat(32)}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(challengeResponse.statusCode).toBe(200);
    expect(sessionResponse.statusCode).toBe(201);
    expect(protectedResponse.statusCode).toBe(204);
    expect(replayResponse.statusCode).toBe(404);
    expect(replayResponse.json()).toEqual({ code: "CHALLENGE_NOT_FOUND" });
    expect(unauthenticatedEnvelope.statusCode).toBe(401);
    expect(authenticatedEnvelope.statusCode).toBe(404);
    await app.close();
  });

  it("rejects a signature produced by a different wallet", async () => {
    const auth = createInMemoryWalletAuth();
    const app = createApp({ walletAuth: auth });
    const challengeResponse = await app.inject({
      method: "POST",
      url: "/v1/auth/challenges",
      payload: { address: owner.address },
    });
    const challenge = challengeResponse.json<{
      challenge: { nonce: string; message: string };
    }>().challenge;
    const signature = await stranger.signMessage({ message: challenge.message });

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/sessions",
      payload: { address: owner.address, nonce: challenge.nonce, signature },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ code: "INVALID_SIGNATURE" });
    await app.close();
  });

  it("expires bearer sessions", async () => {
    let clock = Date.parse("2026-07-22T12:00:00.000Z");
    const auth = createInMemoryWalletAuth({ now: () => clock, sessionLifetimeMs: 1_000 });
    const actor = address(owner.address);
    const challenge = auth.issueChallenge(actor);
    const signature = await owner.signMessage({ message: challenge.message });
    const session = await auth.createSession({ actor, nonce: challenge.nonce, signature });

    expect(auth.authenticate(`Bearer ${session.token}`)).toBe(actor);
    clock += 1_001;
    expect(() => auth.authenticate(`Bearer ${session.token}`)).toThrowError(
      "A valid wallet session is required",
    );
  });
});
