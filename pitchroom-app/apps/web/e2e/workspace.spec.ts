import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

const fixture = (name: string) => resolve(process.cwd(), "e2e", "fixtures", name);

async function reset(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page.getByRole("main")).toBeVisible();
  await page.getByRole("button", { name: "Reset synthetic project" }).click();
  await expect(page.getByText("Project state: empty")).toBeVisible();
}

test.beforeEach(async ({ page }) => reset(page));

test("material to reviewed understanding to explicit acceptance", async ({ page }) => {
  await page.getByRole("button", { name: "Add material" }).click();
  await expect(page.getByText("Project state: materials ready")).toBeVisible();
  await page.getByRole("button", { name: "Run understanding agent" }).click();
  await expect(page.getByText("Project state: review required")).toBeVisible();
  await expect(page.getByText("Exact source quote")).toBeVisible();

  await page.getByLabel("Answer the agent’s question").fill("Approve the twelve-team expansion pilot.");
  await page.getByRole("button", { name: "Record answer" }).click();
  await expect(page.getByLabel("Answer the agent’s question")).toHaveValue("");
  await expect(page.getByRole("button", { name: "Record answer" })).toBeDisabled();
  await expect(page.getByText("Approve the twelve-team expansion pilot.")).toBeVisible();

  await page.getByRole("button", { name: /Accept version/ }).click();
  await expect(page.getByText("Understanding accepted.")).toBeVisible();
  await expect(page.getByText("The agent is stopped.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your review is the gate" })).toHaveCount(0);
});

test("uploaded Markdown conflict remains explicit and unresolved", async ({ page }) => {
  await page.locator("#material-file").setInputFiles(fixture("source-a.md"));
  await expect(page.getByText("source-a.md", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Add files/ }).click();
  await page.locator("#upload-material-file").setInputFiles(fixture("source-b.md"));
  await expect(page.getByText("source-b.md", { exact: true })).toBeVisible();
  await expect(page.getByText("2 files")).toBeVisible();
  await page.getByRole("button", { name: "Run understanding agent" }).click();

  await expect(page.getByText("conflicting", { exact: true })).toBeVisible();
  await expect(page.locator("blockquote").filter({ hasText: "twelve teams" })).toBeVisible();
  await expect(page.locator("blockquote").filter({ hasText: "eighteen teams" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Which source should be treated as current, and why?" })).toBeVisible();
  await page.getByRole("button", { name: "Keep unknown" }).click();
  await expect(page.getByText("Understanding v2")).toBeVisible();
  await expect(page.getByText("conflicting", { exact: true })).toBeVisible();
});

test("unsupported file reports a recoverable error", async ({ page }) => {
  await page.locator("#material-file").setInputFiles(fixture("unsupported.json"));
  await expect(page.locator(".error[role=alert]")).toContainText("Choose a UTF-8 .txt or .md file.");
  await page.locator("#material-file").setInputFiles(fixture("source-a.md"));
  await expect(page.locator(".error[role=alert]")).toHaveCount(0);
  await expect(page.getByText("source-a.md", { exact: true })).toBeVisible();
  await expect(page.getByText("Project state: materials ready")).toBeVisible();
});

test("stale second tab fails closed and can refresh", async ({ page, context }) => {
  await page.getByRole("button", { name: "Add material" }).click();
  await page.getByRole("button", { name: "Run understanding agent" }).click();
  await expect(page.getByText("Project state: review required")).toBeVisible();

  const stalePage = await context.newPage();
  await stalePage.route("**/api/workspace/events", (route) => route.abort());
  await stalePage.goto("/");
  await expect(stalePage.getByText("Understanding v1")).toBeVisible();

  await page.getByLabel("Correct the first claim").fill("Current correction from tab one.");
  await page.getByRole("button", { name: "Record correction" }).click();
  await expect(page.getByText("Understanding v2")).toBeVisible();

  await stalePage.getByLabel("Correct the first claim").fill("Stale correction from tab two.");
  await stalePage.getByRole("button", { name: "Record correction" }).click();
  await expect(stalePage.locator(".error[role=alert]")).toContainText("stale");
  await stalePage.reload();
  await expect(stalePage.getByText("Understanding v2")).toBeVisible();
  await stalePage.close();
});

test("workspace survives an event-stream disconnect and reload", async ({ page }) => {
  await page.route("**/api/workspace/events", (route) => route.abort());
  await page.getByRole("button", { name: "Add material" }).click();
  await page.getByRole("button", { name: "Run understanding agent" }).click();
  await expect(page.getByText("Project state: review required")).toBeVisible();
  await page.unroute("**/api/workspace/events");
  await page.reload();
  await expect(page.getByText("Project state: review required")).toBeVisible();
  await expect(page.getByText("Exact source quote")).toBeVisible();
});
