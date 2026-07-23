import { expect, test } from "@playwright/test";

import { anvilAccounts, installAnvilWallet, useAnvilAccount } from "./support/anvil-wallet.js";

test("creates, approves, simulates, and publicly references an encrypted invoice", async ({
  page,
  isMobile,
}) => {
  test.skip(
    Boolean(isMobile),
    "The full workflow runs once; mobile behavior has separate coverage.",
  );
  await installAnvilWallet(page, 3);
  await page.goto("/");

  await page.getByRole("button", { name: "Connect wallet" }).click();
  await expect(page.getByRole("button", { name: "0x90f7…b906" })).toBeVisible();

  await useAnvilAccount(page, 2);
  await page.getByRole("button", { name: "0x90f7…b906" }).click();
  await expect(page.getByRole("button", { name: "0x3c44…93bc" })).toBeVisible();

  await page.getByLabel("Payer wallet").fill(anvilAccounts[3]);
  await page.getByLabel("Amount encrypted").fill("625.00");
  await page.getByLabel("Private memo").fill("Browser lifecycle security review");
  await page.getByRole("button", { name: "Encrypt and register" }).click();

  const result = page.locator(".record-result");
  await expect(result.getByText("REGISTERED", { exact: true })).toBeVisible();
  await expect(result).toContainText("625.00 USDC");
  const invoiceId = await page.getByLabel("Invoice ID").inputValue();
  expect(invoiceId).toMatch(/^0x[0-9a-f]{64}$/);

  await useAnvilAccount(page, 3);
  await page.getByRole("button", { name: "0x3c44…93bc" }).click();
  await expect(page.getByRole("button", { name: "0x90f7…b906" })).toBeVisible();
  await page.getByRole("button", { name: "Approve as payer" }).click();

  await expect(result.getByText("APPROVED", { exact: true })).toBeVisible();
  await expect(result).toContainText("Browser lifecycle security review");

  await page.getByRole("button", { name: "Simulate payment" }).click();
  await expect(page.getByText("Simulation only · no payment sent")).toBeVisible();
  await expect(page.getByText("SIMULATED_NOT_BROADCAST")).toBeVisible();

  await page
    .getByRole("checkbox", {
      name: "I understand this transfer's amount, sender, recipient, and transaction are public onchain.",
    })
    .check();
  await page.getByRole("button", { name: "Send public payment" }).click();

  await expect(
    page.getByText("Public onchain transfer · amount and parties are inspectable"),
  ).toBeVisible();
  await expect(result.getByText("PAYMENT_REFERENCED", { exact: true })).toBeVisible();
  await expect(result).toContainText(
    "Confirmed public transfer reference attached; amount was not reconciled",
  );
});
