import { expect, test } from "@playwright/test";

test("explains the problem, purpose, and current privacy boundary", async ({ page }) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", { level: 1, name: "Commercial privacy, without the theatre." }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Public ledgers make poor filing cabinets." }),
  ).toBeVisible();
  await expect(page.getByText("Private systems demand trust")).toBeVisible();
  await expect(page.getByText("Privacy claims blur public facts")).toBeVisible();

  await expect(
    page.getByRole("heading", { name: "Separate private content from public coordination." }),
  ).toBeVisible();
  await expect(page.getByText("Local Anvil · Chain 31337")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Know what stays private. Know what goes public." }),
  ).toBeVisible();
  await expect(page.getByText("Payments are public onchain.")).toBeVisible();
  await expect(page.getByText("Testnet prototype", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect wallet" })).toBeVisible();
});
