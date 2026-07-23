import type { Page } from "@playwright/test";

const rpcUrl = "http://127.0.0.1:18545";

export const anvilAccounts = [
  "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
  "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
] as const;

export async function installAnvilWallet(page: Page, initialAccount = 0): Promise<void> {
  await page.addInitScript(
    ({ accounts, initialIndex, url }) => {
      let accountIndex = initialIndex;
      let requestId = 0;
      const rpc = async (method: string, params: readonly unknown[] = []) => {
        const response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: (requestId += 1),
            method,
            params,
          }),
        });
        const payload = (await response.json()) as {
          result?: unknown;
          error?: { message?: string };
        };
        if (payload.error !== undefined) {
          throw new Error(payload.error.message ?? `${method} failed`);
        }
        return payload.result;
      };
      const provider = {
        request: async ({ method, params }: { method: string; params?: readonly unknown[] }) => {
          if (method === "eth_requestAccounts" || method === "eth_accounts") {
            return [accounts[accountIndex]];
          }
          if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") {
            return null;
          }
          return rpc(method, params);
        },
      };
      Object.defineProperty(window, "ethereum", { configurable: true, value: provider });
      Object.defineProperty(window, "__quietpactTestWallet", {
        configurable: true,
        value: {
          rpc,
          useAccount(index: number) {
            if (!Number.isInteger(index) || index < 0 || index >= accounts.length) {
              throw new Error(`Unknown Anvil account index: ${String(index)}`);
            }
            accountIndex = index;
            return accounts[index];
          },
        },
      });
    },
    { accounts: anvilAccounts, initialIndex: initialAccount, url: rpcUrl },
  );
}

export async function useAnvilAccount(page: Page, index: number): Promise<string> {
  return page.evaluate((nextIndex) => {
    const controls = (
      window as unknown as {
        __quietpactTestWallet: { useAccount(index: number): string };
      }
    ).__quietpactTestWallet;
    return controls.useAccount(nextIndex);
  }, index);
}

export async function anvilRpc(
  page: Page,
  method: string,
  params: readonly unknown[] = [],
): Promise<unknown> {
  return page.evaluate(
    ({ rpcMethod, rpcParams }) => {
      const controls = (
        window as unknown as {
          __quietpactTestWallet: {
            rpc(method: string, params: readonly unknown[]): Promise<unknown>;
          };
        }
      ).__quietpactTestWallet;
      return controls.rpc(rpcMethod, rpcParams);
    },
    { rpcMethod: method, rpcParams: params },
  );
}
