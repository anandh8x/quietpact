import { expect, test } from "@playwright/test";

import {
  anvilAccounts,
  anvilRpc,
  installAnvilWallet,
  useAnvilAccount,
} from "./support/anvil-wallet.js";

test("commits, backs up, reveals, finalizes, and withdraws a sealed bid", async ({
  page,
  isMobile,
}) => {
  test.skip(
    Boolean(isMobile),
    "The full workflow runs once; mobile behavior has separate coverage.",
  );
  await installAnvilWallet(page, 0);
  await page.goto("/");

  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.getByLabel("Opens after (seconds)").fill("60");
  await page.getByLabel("Commit window (seconds)").fill("120");
  await page.getByLabel("Reveal window (seconds)").fill("120");
  await page.getByLabel("Fixed bond (local ETH)").fill("0.01");
  await page.getByRole("button", { name: "Create auction" }).click();

  await expect(page.getByText("Auction created. Share its ID with bidders.")).toBeVisible();
  const auctionId = await page.getByLabel("Auction ID").inputValue();
  expect(auctionId).toMatch(/^0x[0-9a-f]{64}$/);

  await moveTime(page, 61);
  await useAnvilAccount(page, 1);
  await page.getByRole("button", { name: "0xf39f…2266" }).click();
  await expect(page.getByRole("button", { name: "0x7099…79c8" })).toBeVisible();
  await page.getByRole("button", { name: "Refresh auction" }).click();

  const status = page.locator(".auction-status");
  await expect(status).toContainText("COMMIT_OPEN");
  await page.getByLabel("Bid amount").fill("60");
  await page.getByRole("button", { name: "Commit bid + bond" }).click();

  await expect(
    page.getByText("Bid committed. Export the opening backup before leaving this browser."),
  ).toBeVisible();
  await expect(status).toContainText("HIDDEN UNTIL REVEAL");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export encrypted opening" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^quietpact-bid-[0-9a-f]{8}\.json$/);
  await expect(
    page.getByText("Bid opening backup exported. Keep it private until reveal."),
  ).toBeVisible();

  await moveTime(page, 121);
  await page.getByRole("button", { name: "Refresh auction" }).click();
  await expect(status).toContainText("REVEAL_OPEN");
  await page.getByRole("button", { name: "Reveal saved bid" }).click();

  await expect(page.getByText("Bid revealed. Its amount is now public onchain.")).toBeVisible();
  await expect(status).toContainText("60 · PUBLIC AFTER REVEAL");

  await moveTime(page, 121);
  await page.getByRole("button", { name: "Refresh auction" }).click();
  await expect(status).toContainText("FINALIZABLE");

  await useAnvilAccount(page, 0);
  await page.getByRole("button", { name: "0x7099…79c8" }).click();
  await page.getByRole("button", { name: "Refresh auction" }).click();
  await page.getByRole("button", { name: "Finalize auction" }).click();

  await expect(page.getByText("Auction finalized and bond credits calculated.")).toBeVisible();
  await expect(status).toContainText("FINALIZED");
  await expect(status).toContainText(shortAddress(anvilAccounts[1]));

  await useAnvilAccount(page, 1);
  await page.getByRole("button", { name: "0xf39f…2266" }).click();
  await page.getByRole("button", { name: "Refresh auction" }).click();
  await expect(status).toContainText("0.01 local ETH");
  await page.getByRole("button", { name: "Withdraw bond credit" }).click();

  await expect(page.getByText("Available bond credit withdrawn.")).toBeVisible();
  await expect(status).toContainText("0 local ETH");
});

async function moveTime(page: Parameters<typeof anvilRpc>[0], seconds: number): Promise<void> {
  await anvilRpc(page, "evm_increaseTime", [seconds]);
  await anvilRpc(page, "evm_mine");
}

function shortAddress(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
