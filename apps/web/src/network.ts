import { defineChain, type Chain } from "viem";
import { arcTestnet } from "viem/chains";

const ARC_TESTNET_CHAIN_ID = 5_042_002n;
const ARC_TESTNET_EXPLORER = "https://testnet.arcscan.app";

export interface QuietPactNetwork {
  readonly mode: "LOCAL" | "ARC_TESTNET";
  readonly chainId: bigint;
  readonly chain: Chain;
  readonly name: string;
  readonly walletLabel: string;
  readonly statusLabel: string;
  readonly connectedLabel: string;
  readonly nativeAsset: "ETH" | "USDC";
  readonly paymentUnit: "local ETH" | "USDC";
  readonly explorerUrl: string | null;
}

export function resolveQuietPactNetwork(input: {
  readonly chainId: string;
  readonly rpcUrl: string;
}): QuietPactNetwork {
  const chainId = parseChainId(input.chainId);
  if (chainId === ARC_TESTNET_CHAIN_ID) {
    const chain: Chain = {
      ...arcTestnet,
      rpcUrls: {
        ...arcTestnet.rpcUrls,
        default: {
          ...arcTestnet.rpcUrls.default,
          http: [input.rpcUrl],
        },
      },
    };
    return Object.freeze({
      mode: "ARC_TESTNET",
      chainId,
      chain,
      name: "Arc Testnet",
      walletLabel: "Arc Testnet · 5042002",
      statusLabel: "Arc Testnet · Chain 5042002",
      connectedLabel: "Connected to Arc Testnet",
      nativeAsset: "USDC",
      paymentUnit: "USDC",
      explorerUrl: ARC_TESTNET_EXPLORER,
    });
  }

  const chain = defineChain({
    id: Number(chainId),
    name: "QuietPact local chain",
    nativeCurrency: { name: "Local Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [input.rpcUrl] } },
  });
  return Object.freeze({
    mode: "LOCAL",
    chainId,
    chain,
    name: "Local Anvil",
    walletLabel: `Local Anvil · ${chainId}`,
    statusLabel: `Local Anvil · Chain ${chainId}`,
    connectedLabel: "Connected to local chain",
    nativeAsset: "ETH",
    paymentUnit: "local ETH",
    explorerUrl: null,
  });
}

function parseChainId(value: string): bigint {
  try {
    const parsed = BigInt(value);
    if (parsed <= 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error();
    return parsed;
  } catch {
    throw new Error("VITE_QUIETPACT_CHAIN_ID must be a positive integer");
  }
}
