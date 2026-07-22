import { describe, expect, it } from "vitest";

import {
  address,
  auctionId,
  commitmentHash,
  createProcurementModule,
  secretSalt,
  unixTimestamp,
} from "../src/index.js";

describe("procurement workflow", () => {
  it("derives scheduled and commit-open states from auction time", async () => {
    let now = unixTimestamp(100);
    const procurement = createProcurementModule({ now: () => now });
    const owner = address("0x1000000000000000000000000000000000000001");
    const id = auctionId("auction-001");

    const created = await procurement.create({
      actor: owner,
      id,
      owner,
      commitOpensAt: unixTimestamp(200),
      revealOpensAt: unixTimestamp(300),
      revealClosesAt: unixTimestamp(400),
      fixedBond: 10n,
    });

    expect(created).toMatchObject({
      id,
      owner,
      state: "SCHEDULED",
      bids: [],
      winner: null,
    });
    now = unixTimestamp(200);
    await expect(procurement.view(id)).resolves.toMatchObject({ state: "COMMIT_OPEN" });
  });

  it("keeps committed bid amounts hidden through the commit window", async () => {
    let now = unixTimestamp(200);
    const procurement = createProcurementModule({ now: () => now });
    const owner = address("0x1000000000000000000000000000000000000001");
    const bidder = address("0x2000000000000000000000000000000000000002");
    const id = auctionId("auction-hidden-bid");
    await procurement.create({
      actor: owner,
      id,
      owner,
      commitOpensAt: unixTimestamp(200),
      revealOpensAt: unixTimestamp(300),
      revealClosesAt: unixTimestamp(400),
      fixedBond: 10n,
    });

    const committed = await procurement.act(id, {
      type: "commitBid",
      actor: bidder,
      commitment: commitmentHash(`0x${"11".repeat(32)}`),
    });

    expect(committed.bids).toEqual([
      {
        bidder,
        status: "COMMITTED",
        visibility: "HIDDEN_UNTIL_REVEAL",
      },
    ]);
    expect(JSON.stringify(committed.bids)).not.toContain("amount");
    now = unixTimestamp(300);
    await expect(procurement.view(id)).resolves.toMatchObject({
      state: "REVEAL_OPEN",
      bids: [{ bidder, status: "COMMITTED", visibility: "HIDDEN_UNTIL_REVEAL" }],
    });
  });

  it("publishes a bid amount only after its opening is verified", async () => {
    let now = unixTimestamp(200);
    const expectedCommitment = commitmentHash(`0x${"22".repeat(32)}`);
    const expectedSalt = secretSalt(`0x${"33".repeat(32)}`);
    const procurement = createProcurementModule({
      now: () => now,
      verifyOpening: ({ commitment, amount, salt }) =>
        commitment === expectedCommitment && amount === 75n && salt === expectedSalt,
    });
    const owner = address("0x1000000000000000000000000000000000000001");
    const bidder = address("0x2000000000000000000000000000000000000002");
    const id = auctionId("auction-reveal");
    await procurement.create({
      actor: owner,
      id,
      owner,
      commitOpensAt: unixTimestamp(200),
      revealOpensAt: unixTimestamp(300),
      revealClosesAt: unixTimestamp(400),
      fixedBond: 10n,
    });
    await procurement.act(id, {
      type: "commitBid",
      actor: bidder,
      commitment: expectedCommitment,
    });

    now = unixTimestamp(300);
    const revealed = await procurement.act(id, {
      type: "revealBid",
      actor: bidder,
      amount: 75n,
      salt: expectedSalt,
    });

    expect(revealed.bids).toEqual([
      {
        bidder,
        status: "REVEALED",
        visibility: "PUBLIC_AFTER_REVEAL",
        amount: 75n,
      },
    ]);
  });

  it("finalizes the lowest revealed bid after the reveal deadline", async () => {
    let now = unixTimestamp(200);
    const procurement = createProcurementModule({
      now: () => now,
      verifyOpening: () => true,
    });
    const owner = address("0x1000000000000000000000000000000000000001");
    const bidders = [
      address("0x2000000000000000000000000000000000000002"),
      address("0x3000000000000000000000000000000000000003"),
      address("0x4000000000000000000000000000000000000004"),
    ] as const;
    const amounts = [90n, 60n, 75n] as const;
    const id = auctionId("auction-finalize");
    await procurement.create({
      actor: owner,
      id,
      owner,
      commitOpensAt: unixTimestamp(200),
      revealOpensAt: unixTimestamp(300),
      revealClosesAt: unixTimestamp(400),
      fixedBond: 10n,
    });

    for (const [index, bidder] of bidders.entries()) {
      await procurement.act(id, {
        type: "commitBid",
        actor: bidder,
        commitment: commitmentHash(
          `0x${String(index + 1)
            .padStart(2, "0")
            .repeat(32)}`,
        ),
      });
    }
    now = unixTimestamp(300);
    for (const [index, bidder] of bidders.entries()) {
      await procurement.act(id, {
        type: "revealBid",
        actor: bidder,
        amount: amounts[index]!,
        salt: secretSalt(
          `0x${String(index + 11)
            .padStart(2, "0")
            .repeat(32)}`,
        ),
      });
    }

    now = unixTimestamp(400);
    await expect(procurement.view(id)).resolves.toMatchObject({ state: "FINALIZABLE" });
    await expect(procurement.act(id, { type: "finalize", actor: owner })).resolves.toMatchObject({
      state: "FINALIZED",
      winner: { bidder: bidders[1], amount: 60n },
    });
  });

  it("rejects unauthorized, invalid, and duplicate auction definitions", async () => {
    const now = unixTimestamp(100);
    const procurement = createProcurementModule({ now: () => now });
    const owner = address("0x1000000000000000000000000000000000000001");
    const stranger = address("0x2000000000000000000000000000000000000002");
    const id = auctionId("auction-definition-policy");
    const valid = {
      actor: owner,
      id,
      owner,
      commitOpensAt: unixTimestamp(200),
      revealOpensAt: unixTimestamp(300),
      revealClosesAt: unixTimestamp(400),
      fixedBond: 10n,
    } as const;

    await expect(procurement.create({ ...valid, actor: stranger })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      procurement.create({
        ...valid,
        revealOpensAt: unixTimestamp(200),
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(procurement.create({ ...valid, fixedBond: -1n })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await procurement.create(valid);
    await expect(procurement.create(valid)).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
  });

  it("enforces commit, reveal, and finalization boundaries", async () => {
    let now = unixTimestamp(199);
    const procurement = createProcurementModule({
      now: () => now,
      verifyOpening: () => false,
    });
    const owner = address("0x1000000000000000000000000000000000000001");
    const bidder = address("0x2000000000000000000000000000000000000002");
    const stranger = address("0x3000000000000000000000000000000000000003");
    const id = auctionId("auction-boundaries");
    const commitment = commitmentHash(`0x${"44".repeat(32)}`);
    const salt = secretSalt(`0x${"55".repeat(32)}`);
    await procurement.create({
      actor: owner,
      id,
      owner,
      commitOpensAt: unixTimestamp(200),
      revealOpensAt: unixTimestamp(300),
      revealClosesAt: unixTimestamp(400),
      fixedBond: 10n,
    });

    await expect(
      procurement.act(id, { type: "commitBid", actor: bidder, commitment }),
    ).rejects.toMatchObject({ code: "BIDDING_NOT_OPEN" });
    now = unixTimestamp(200);
    await procurement.act(id, { type: "commitBid", actor: bidder, commitment });
    await expect(
      procurement.act(id, { type: "commitBid", actor: bidder, commitment }),
    ).rejects.toMatchObject({ code: "DUPLICATE_ACTION" });
    await expect(
      procurement.act(id, { type: "revealBid", actor: bidder, amount: 10n, salt }),
    ).rejects.toMatchObject({ code: "REVEAL_NOT_OPEN" });
    await expect(procurement.act(id, { type: "finalize", actor: owner })).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
    });

    now = unixTimestamp(300);
    await expect(
      procurement.act(id, { type: "commitBid", actor: stranger, commitment }),
    ).rejects.toMatchObject({ code: "BIDDING_CLOSED" });
    await expect(
      procurement.act(id, { type: "revealBid", actor: stranger, amount: 10n, salt }),
    ).rejects.toMatchObject({ code: "NO_COMMITMENT" });
    await expect(
      procurement.act(id, { type: "revealBid", actor: bidder, amount: 10n, salt }),
    ).rejects.toMatchObject({ code: "COMMITMENT_MISMATCH" });

    now = unixTimestamp(400);
    await expect(
      procurement.act(id, { type: "revealBid", actor: bidder, amount: 10n, salt }),
    ).rejects.toMatchObject({ code: "REVEAL_CLOSED" });
    await expect(procurement.act(id, { type: "finalize", actor: stranger })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(procurement.act(id, { type: "finalize", actor: owner })).resolves.toMatchObject({
      state: "FINALIZED",
      winner: null,
    });
    await expect(procurement.act(id, { type: "finalize", actor: owner })).rejects.toMatchObject({
      code: "DUPLICATE_ACTION",
    });
  });

  it("breaks equal-bid ties by canonical bidder address", async () => {
    let now = unixTimestamp(200);
    const procurement = createProcurementModule({
      now: () => now,
      verifyOpening: () => true,
    });
    const owner = address("0x1000000000000000000000000000000000000001");
    const higherAddress = address("0x3000000000000000000000000000000000000003");
    const lowerAddress = address("0x2000000000000000000000000000000000000002");
    const id = auctionId("auction-tie");
    await procurement.create({
      actor: owner,
      id,
      owner,
      commitOpensAt: unixTimestamp(200),
      revealOpensAt: unixTimestamp(300),
      revealClosesAt: unixTimestamp(400),
      fixedBond: 0n,
    });
    for (const [index, bidder] of [higherAddress, lowerAddress].entries()) {
      await procurement.act(id, {
        type: "commitBid",
        actor: bidder,
        commitment: commitmentHash(`0x${String(index + 21).repeat(32)}`),
      });
    }
    now = unixTimestamp(300);
    for (const [index, bidder] of [higherAddress, lowerAddress].entries()) {
      await procurement.act(id, {
        type: "revealBid",
        actor: bidder,
        amount: 50n,
        salt: secretSalt(`0x${String(index + 31).repeat(32)}`),
      });
    }

    now = unixTimestamp(400);
    await expect(procurement.act(id, { type: "finalize", actor: owner })).resolves.toMatchObject({
      winner: { bidder: lowerAddress, amount: 50n },
    });
  });
});
