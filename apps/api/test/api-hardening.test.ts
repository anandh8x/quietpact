import { describe, expect, it } from "vitest";

import { createApp, createInMemoryEncryptionKeyRepository } from "../src/app.js";
import { createInMemoryWalletAuth } from "../src/wallet-auth.js";

const actor = "0x1000000000000000000000000000000000000001";

describe("API abuse resistance", () => {
  it("rate limits wallet authentication requests per client", async () => {
    let clock = Date.parse("2026-07-23T12:00:00.000Z");
    const app = createApp({
      walletAuth: createInMemoryWalletAuth(),
      authRateLimit: {
        maxRequests: 2,
        windowMs: 60_000,
        now: () => clock,
      },
    });
    const request = () =>
      app.inject({
        method: "POST",
        url: "/v1/auth/challenges",
        remoteAddress: "203.0.113.10",
        payload: { address: actor },
      });

    expect((await request()).statusCode).toBe(200);
    expect((await request()).statusCode).toBe(200);

    const limited = await request();
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ code: "RATE_LIMITED" });
    expect(limited.headers["retry-after"]).toBe("60");

    clock += 60_000;
    expect((await request()).statusCode).toBe(200);
    await app.close();
  });

  it("rejects request bodies above the configured content limit", async () => {
    const app = createApp({
      walletAuth: createInMemoryWalletAuth(),
      bodyLimitBytes: 128,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/challenges",
      payload: { address: actor, padding: "A".repeat(256) },
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({ code: "PAYLOAD_TOO_LARGE" });
    expect(response.body).not.toContain("A".repeat(64));
    await app.close();
  });

  it("returns stable public errors without reflecting malformed or internal details", async () => {
    const app = createApp({
      authenticate: () => {
        throw new Error("INTERNAL_PRIVACY_CANARY_5c91");
      },
      encryptionKeys: createInMemoryEncryptionKeyRepository(),
      walletAuth: createInMemoryWalletAuth(),
      logger: false,
    });

    const malformed = await app.inject({
      method: "POST",
      url: "/v1/auth/challenges",
      headers: { "content-type": "application/json" },
      payload: '{"private":"MALFORMED_PRIVACY_CANARY_2a77"',
    });
    const internal = await app.inject({
      method: "PUT",
      url: `/v1/encryption-keys/${actor}`,
      payload: { publicKey: "A".repeat(44) },
    });

    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({ code: "INVALID_REQUEST" });
    expect(malformed.body).not.toContain("MALFORMED_PRIVACY_CANARY_2a77");
    expect(internal.statusCode).toBe(500);
    expect(internal.json()).toEqual({ code: "INTERNAL_ERROR" });
    expect(internal.body).not.toContain("INTERNAL_PRIVACY_CANARY_5c91");
    await app.close();
  });
});
