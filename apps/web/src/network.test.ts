import { describe, expect, it } from "vitest";

import { resolveQuietPactNetwork } from "./network.js";

describe("QuietPact runtime network", () => {
  it("uses Arc Testnet's official chain identity and public-USDC labels", () => {
    const network = resolveQuietPactNetwork({
      chainId: "5042002",
      rpcUrl: "https://rpc.testnet.arc.network",
    });

    expect(network).toMatchObject({
      mode: "ARC_TESTNET",
      chainId: 5_042_002n,
      name: "Arc Testnet",
      walletLabel: "Arc Testnet · 5042002",
      statusLabel: "Arc Testnet · Chain 5042002",
      connectedLabel: "Connected to Arc Testnet",
      nativeAsset: "USDC",
      paymentUnit: "USDC",
      explorerUrl: "https://testnet.arcscan.app",
    });
    expect(network.chain).toMatchObject({
      id: 5_042_002,
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
      testnet: true,
    });
  });

  it("preserves the disposable Anvil network as the development default", () => {
    const network = resolveQuietPactNetwork({
      chainId: "31337",
      rpcUrl: "http://127.0.0.1:8545",
    });

    expect(network).toMatchObject({
      mode: "LOCAL",
      chainId: 31_337n,
      name: "Local Anvil",
      walletLabel: "Local Anvil · 31337",
      statusLabel: "Local Anvil · Chain 31337",
      connectedLabel: "Connected to local chain",
      nativeAsset: "ETH",
      paymentUnit: "local ETH",
      explorerUrl: null,
    });
    expect(network.chain).toMatchObject({
      id: 31_337,
      nativeCurrency: { name: "Local Ether", symbol: "ETH", decimals: 18 },
    });
  });
});
