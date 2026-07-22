import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";

import { address, secretSalt } from "@quietpact/domain";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  parseEther,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createViemAuctionRecords } from "../src/index.js";

const rpcUrl = "http://127.0.0.1:18547";
const ownerAccount = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const bidderOneAccount = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const bidderTwoAccount = privateKeyToAccount(
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
);
const bidderThreeAccount = privateKeyToAccount(
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
);
const accounts = [ownerAccount, bidderOneAccount, bidderTwoAccount, bidderThreeAccount] as const;
const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) });
const testClient = createTestClient({ chain: foundry, mode: "anvil", transport: http(rpcUrl) });
const walletFor = (account: (typeof accounts)[number]) =>
  createWalletClient({ account, chain: foundry, transport: http(rpcUrl) });

let anvil: ChildProcess;
let auctionContract: `0x${string}`;

beforeAll(async () => {
  anvil = spawn(process.env.ANVIL_BIN ?? "anvil", ["--silent", "--port", "18547"], {
    stdio: "ignore",
  });
  await waitForAnvil();

  const artifactUrl = new URL(
    "../../../contracts/out/SealedBidAuction.sol/SealedBidAuction.json",
    import.meta.url,
  );
  const artifact = JSON.parse(await readFile(artifactUrl, "utf8")) as {
    bytecode: { object: Hex };
  };
  const deploymentHash = await walletFor(ownerAccount).deployContract({
    abi: [],
    bytecode: artifact.bytecode.object,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: deploymentHash });
  if (receipt.contractAddress == null) throw new Error("SealedBidAuction deployment failed");
  auctionContract = receipt.contractAddress;
}, 15_000);

afterAll(() => {
  anvil.kill("SIGTERM");
});

describe("Viem SealedBidAuction adapter on Anvil", () => {
  it("runs three bidders through commit, reveal, forfeiture, finalization, and withdrawal", async () => {
    const wallets = new Map(
      accounts.map((account) => [account.address.toLowerCase(), walletFor(account)]),
    );
    const records = createViemAuctionRecords({
      auction: address(auctionContract),
      publicClient,
      walletClientFor: (actor) => {
        const wallet = wallets.get(actor);
        if (wallet === undefined) throw new Error("No wallet for actor");
        return wallet;
      },
    });
    const owner = address(ownerAccount.address);
    const bidders = [
      address(bidderOneAccount.address),
      address(bidderTwoAccount.address),
      address(bidderThreeAccount.address),
    ] as const;
    const openings = [
      { bidder: bidders[0], amount: 90n, salt: secretSalt(`0x${"11".repeat(32)}`) },
      { bidder: bidders[1], amount: 60n, salt: secretSalt(`0x${"22".repeat(32)}`) },
      { bidder: bidders[2], amount: 75n, salt: secretSalt(`0x${"33".repeat(32)}`) },
    ] as const;
    const id = `0x${"51".repeat(32)}` as const;
    const bond = parseEther("1");
    const latest = await publicClient.getBlock({ blockTag: "latest" });
    const commitOpensAt = latest.timestamp + 10n;
    const revealOpensAt = commitOpensAt + 10n;
    const revealClosesAt = revealOpensAt + 10n;

    await records.create({
      actor: owner,
      id,
      commitOpensAt,
      revealOpensAt,
      revealClosesAt,
      bond,
    });
    await moveTo(commitOpensAt);

    for (const opening of openings) {
      await records.commit({
        actor: opening.bidder,
        id,
        amount: opening.amount,
        salt: opening.salt,
      });
    }

    const hiddenBid = await records.bid(id, bidders[1]);
    expect(hiddenBid).toMatchObject({
      revealed: false,
      amount: null,
      visibility: "HIDDEN_UNTIL_REVEAL",
    });

    await moveTo(revealOpensAt);
    await records.reveal({ actor: bidders[0], id, amount: 90n, salt: openings[0].salt });
    await records.reveal({ actor: bidders[1], id, amount: 60n, salt: openings[1].salt });

    const publicBid = await records.bid(id, bidders[1]);
    expect(publicBid).toMatchObject({
      revealed: true,
      amount: 60n,
      visibility: "PUBLIC_AFTER_REVEAL",
    });

    await moveTo(revealClosesAt);
    const finalized = await records.finalize({ actor: owner, id });

    expect(finalized).toMatchObject({
      phase: "FINALIZED",
      winner: bidders[1],
      winningAmount: 60n,
      bidderCount: 3,
    });
    await expect(records.credit(bidders[0])).resolves.toBe(bond);
    await expect(records.credit(bidders[1])).resolves.toBe(bond);
    await expect(records.credit(bidders[2])).resolves.toBe(0n);
    await expect(records.credit(owner)).resolves.toBe(bond);

    await records.withdraw(bidders[0]);
    await records.withdraw(bidders[1]);
    await records.withdraw(owner);
    await expect(records.credit(bidders[0])).resolves.toBe(0n);
    await expect(records.credit(bidders[1])).resolves.toBe(0n);
    await expect(records.credit(owner)).resolves.toBe(0n);
  });
});

async function moveTo(timestamp: bigint): Promise<void> {
  await testClient.setNextBlockTimestamp({ timestamp });
  await testClient.mine({ blocks: 1 });
}

async function waitForAnvil(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (anvil.exitCode !== null) throw new Error("Anvil exited before accepting connections");
    try {
      await publicClient.getChainId();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Timed out waiting for Anvil");
}
