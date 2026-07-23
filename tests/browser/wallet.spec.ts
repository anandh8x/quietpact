import { expect, test } from "@playwright/test";

const account = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

test("explains that a rejected wallet signature submitted nothing", async ({ page }) => {
  await page.addInitScript(
    ({ walletAccount }) => {
      Object.defineProperty(window, "ethereum", {
        configurable: true,
        value: {
          request: ({ method }: { method: string }) => {
            if (method === "eth_requestAccounts" || method === "eth_accounts") {
              return Promise.resolve([walletAccount]);
            }
            if (method === "eth_chainId") return Promise.resolve("0x7a69");
            if (method === "personal_sign") {
              const rejection = new Error("User rejected the request.");
              Object.assign(rejection, { code: 4001 });
              return Promise.reject(rejection);
            }
            return Promise.reject(new Error(`Unexpected wallet method: ${method}`));
          },
        },
      });
    },
    { walletAccount: account },
  );
  await page.route("**/api/v1/auth/challenges", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        challenge: {
          nonce: "browser-test-nonce",
          message: "QuietPact browser test authentication",
        },
      }),
    });
  });
  await page.goto("/");

  await page.getByRole("button", { name: "Connect wallet" }).click();

  await expect(page.getByRole("alert")).toContainText(
    "The wallet request was cancelled. Nothing was submitted.",
  );
  await expect(page.getByRole("button", { name: "Connect wallet" })).toBeEnabled();
});

test("switches a wallet from the wrong chain before showing it as connected", async ({ page }) => {
  await page.addInitScript(
    ({ walletAccount }) => {
      let chainId = "0x1";
      Object.defineProperty(window, "ethereum", {
        configurable: true,
        value: {
          request: ({ method, params }: { method: string; params?: readonly unknown[] }) => {
            if (method === "eth_requestAccounts" || method === "eth_accounts") {
              return Promise.resolve([walletAccount]);
            }
            if (method === "eth_chainId") return Promise.resolve(chainId);
            if (method === "wallet_switchEthereumChain") {
              const requested = params?.[0] as { chainId?: string } | undefined;
              if (requested?.chainId !== "0x7a69") {
                return Promise.reject(new Error("QuietPact requested the wrong chain"));
              }
              chainId = requested.chainId;
              return Promise.resolve(null);
            }
            if (method === "personal_sign") return Promise.resolve(`0x${"11".repeat(65)}`);
            return Promise.reject(new Error(`Unexpected wallet method: ${method}`));
          },
        },
      });
    },
    { walletAccount: account },
  );
  await page.route("**/api/v1/auth/challenges", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        challenge: {
          nonce: "browser-test-nonce",
          message: "QuietPact browser test authentication",
        },
      }),
    });
  });
  await page.route("**/api/v1/auth/sessions", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ session: { token: "browser-test-token" } }),
    });
  });
  await page.route("**/api/v1/encryption-keys/*", async (route) => {
    await route.fulfill({ contentType: "application/json", body: "{}" });
  });
  await page.goto("/");

  await page.getByRole("button", { name: "Connect wallet" }).click();

  await expect(page.getByRole("button", { name: "0xf39f…2266" })).toBeVisible();
  await expect(page.getByText("Local Anvil · Chain 31337", { exact: true })).toBeVisible();
  await expect(page.getByText("● Connected to local chain", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("asks the user to reconnect when the API session has expired", async ({ page }) => {
  await page.addInitScript(
    ({ walletAccount }) => {
      Object.defineProperty(window, "ethereum", {
        configurable: true,
        value: {
          request: ({ method }: { method: string }) => {
            if (method === "eth_requestAccounts" || method === "eth_accounts") {
              return Promise.resolve([walletAccount]);
            }
            if (method === "eth_chainId") return Promise.resolve("0x7a69");
            if (method === "personal_sign") return Promise.resolve(`0x${"11".repeat(65)}`);
            return Promise.reject(new Error(`Unexpected wallet method: ${method}`));
          },
        },
      });
    },
    { walletAccount: account },
  );
  await page.route("**/api/v1/auth/challenges", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        challenge: {
          nonce: "browser-test-nonce",
          message: "QuietPact browser test authentication",
        },
      }),
    });
  });
  await page.route("**/api/v1/auth/sessions", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ session: { token: "expired-browser-test-token" } }),
    });
  });
  await page.route("**/api/v1/encryption-keys/*", async (route) => {
    await route.fulfill({ status: 401, contentType: "application/json", body: "{}" });
  });
  await page.goto("/");

  await page.getByRole("button", { name: "Connect wallet" }).click();

  await expect(page.getByRole("alert")).toContainText(
    "Your wallet session expired. Reconnect your wallet and try again.",
  );
  await expect(page.getByRole("button", { name: "Connect wallet" })).toBeEnabled();
});
