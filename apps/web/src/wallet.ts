import { address, type Address } from "@quietpact/domain";
import type { EnvelopeModule, RecipientIdentity, RecipientKey } from "@quietpact/envelope";
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  type EIP1193Provider,
  type PublicClient,
  type WalletClient,
} from "viem";

import { resolveQuietPactNetwork, type QuietPactNetwork } from "./network.js";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

export interface WalletSession {
  readonly account: Address;
  readonly chainId: bigint;
  readonly registry: Address;
  readonly auction: Address;
  readonly network: QuietPactNetwork;
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
}

const defaultLocalRegistry = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const defaultLocalAuction = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512";

export async function connectInjectedWallet(): Promise<WalletSession> {
  const provider = window.ethereum;
  if (provider === undefined) {
    throw new Error("No injected EVM wallet found. Install a browser wallet first.");
  }

  const rpcUrl = import.meta.env.VITE_QUIETPACT_RPC_URL ?? "http://127.0.0.1:8545";
  const network = resolveQuietPactNetwork({
    chainId: import.meta.env.VITE_QUIETPACT_CHAIN_ID ?? "31337",
    rpcUrl,
  });
  const expectedChainId = network.chainId;
  const registry = address(import.meta.env.VITE_QUIETPACT_REGISTRY_ADDRESS ?? defaultLocalRegistry);
  const auction = address(import.meta.env.VITE_QUIETPACT_AUCTION_ADDRESS ?? defaultLocalAuction);
  const chain = network.chain;
  const connector = createWalletClient({ chain, transport: custom(provider) });
  const [walletAddress] = await connector.requestAddresses();
  if (walletAddress === undefined) throw new Error("The wallet did not provide an account");
  let actualChainId = BigInt(await connector.getChainId());
  if (actualChainId !== expectedChainId) {
    try {
      await connector.switchChain({ id: Number(expectedChainId) });
    } catch {
      await connector.addChain({ chain });
      await connector.switchChain({ id: Number(expectedChainId) });
    }
    actualChainId = BigInt(await connector.getChainId());
    if (actualChainId !== expectedChainId) {
      throw new Error(`Wallet could not switch to ${network.name} (${expectedChainId})`);
    }
  }

  return {
    account: address(walletAddress),
    chainId: expectedChainId,
    registry,
    auction,
    network,
    publicClient: createPublicClient({ chain, transport: http(rpcUrl) }),
    walletClient: createWalletClient({
      account: walletAddress,
      chain,
      transport: custom(provider),
    }),
  };
}

export function loadOrCreateIdentity(
  account: Address,
  envelopes: EnvelopeModule,
): RecipientIdentity {
  const storageKey = `quietpact:encryption-identity:${account}`;
  const stored = localStorage.getItem(storageKey);
  if (stored !== null) {
    const parsed: unknown = JSON.parse(stored);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "id" in parsed &&
      parsed.id === account &&
      "publicKey" in parsed &&
      typeof parsed.publicKey === "string" &&
      "privateKey" in parsed &&
      typeof parsed.privateKey === "string"
    ) {
      return parsed as RecipientIdentity;
    }
    throw new Error("Stored encryption identity is invalid; clear this site's local data");
  }

  const identity = envelopes.generateRecipientKeyPair(account);
  localStorage.setItem(storageKey, JSON.stringify(identity));
  return identity;
}

export async function publishEncryptionKey(
  baseUrl: string,
  account: Address,
  identity: RecipientIdentity,
  token: string,
): Promise<void> {
  const response = await fetch(
    `${trimSlash(baseUrl)}/v1/encryption-keys/${encodeURIComponent(account)}`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ publicKey: identity.publicKey }),
    },
  );
  if (!response.ok) throw new Error(`Encryption-key publishing failed (${response.status})`);
}

export async function createApiSession(baseUrl: string, session: WalletSession): Promise<string> {
  const challengeResponse = await fetch(`${trimSlash(baseUrl)}/v1/auth/challenges`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: session.account }),
  });
  if (!challengeResponse.ok) {
    throw new Error(`Wallet challenge request failed (${challengeResponse.status})`);
  }
  const challenge = parseChallenge(await challengeResponse.json());
  const signature = await session.walletClient.signMessage({
    account: session.account,
    message: challenge.message,
  });
  const sessionResponse = await fetch(`${trimSlash(baseUrl)}/v1/auth/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      address: session.account,
      nonce: challenge.nonce,
      signature,
    }),
  });
  if (!sessionResponse.ok) {
    throw new Error(`Wallet session creation failed (${sessionResponse.status})`);
  }
  return parseSessionToken(await sessionResponse.json());
}

export async function getEncryptionKey(baseUrl: string, account: Address): Promise<RecipientKey> {
  const response = await fetch(
    `${trimSlash(baseUrl)}/v1/encryption-keys/${encodeURIComponent(account)}`,
  );
  if (response.status === 404) {
    throw new Error("The other wallet must connect to QuietPact once before receiving invoices");
  }
  if (!response.ok) throw new Error(`Encryption-key lookup failed (${response.status})`);

  const result: unknown = await response.json();
  if (
    result === null ||
    typeof result !== "object" ||
    !("key" in result) ||
    result.key === null ||
    typeof result.key !== "object" ||
    !("id" in result.key) ||
    result.key.id !== account ||
    !("publicKey" in result.key) ||
    typeof result.key.publicKey !== "string"
  ) {
    throw new Error("Encryption-key lookup returned an invalid response");
  }
  return { id: account, publicKey: result.key.publicKey };
}

function trimSlash(value: string): string {
  return value.replace(/\/$/, "");
}

function parseChallenge(value: unknown): { nonce: string; message: string } {
  if (
    value === null ||
    typeof value !== "object" ||
    !("challenge" in value) ||
    value.challenge === null ||
    typeof value.challenge !== "object" ||
    !("nonce" in value.challenge) ||
    typeof value.challenge.nonce !== "string" ||
    !("message" in value.challenge) ||
    typeof value.challenge.message !== "string"
  ) {
    throw new Error("Wallet challenge response is invalid");
  }
  return { nonce: value.challenge.nonce, message: value.challenge.message };
}

function parseSessionToken(value: unknown): string {
  if (
    value === null ||
    typeof value !== "object" ||
    !("session" in value) ||
    value.session === null ||
    typeof value.session !== "object" ||
    !("token" in value.session) ||
    typeof value.session.token !== "string"
  ) {
    throw new Error("Wallet session response is invalid");
  }
  return value.session.token;
}
