import { describe, expect, it } from "vitest";

import { address } from "@quietpact/domain";

import { createApp, createInMemoryEncryptionKeyRepository } from "../src/app.js";

const owner = address("0x2000000000000000000000000000000000000002");
const stranger = address("0x3000000000000000000000000000000000000003");
const publicKey = "A".repeat(44);

describe("encryption key directory", () => {
  it("lets a wallet publish its public key for invoice senders", async () => {
    const app = createApp({
      authenticate: (request) => address(String(request.headers["x-test-wallet"])),
      encryptionKeys: createInMemoryEncryptionKeyRepository(),
    });

    const published = await app.inject({
      method: "PUT",
      url: `/v1/encryption-keys/${owner}`,
      headers: { "x-test-wallet": owner },
      payload: { publicKey },
    });
    const retrieved = await app.inject({
      method: "GET",
      url: `/v1/encryption-keys/${owner}`,
    });

    expect(published.statusCode).toBe(204);
    expect(retrieved.statusCode).toBe(200);
    expect(retrieved.json()).toEqual({ key: { id: owner, publicKey } });
    await app.close();
  });

  it("rejects publishing a key for a different wallet", async () => {
    const app = createApp({
      authenticate: (request) => address(String(request.headers["x-test-wallet"])),
      encryptionKeys: createInMemoryEncryptionKeyRepository(),
    });

    const response = await app.inject({
      method: "PUT",
      url: `/v1/encryption-keys/${owner}`,
      headers: { "x-test-wallet": stranger },
      payload: { publicKey },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ code: "UNAUTHORIZED" });
    await app.close();
  });
});
