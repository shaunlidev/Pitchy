import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

const fixture = (name: string) => resolve(process.cwd(), "e2e", "fixtures", name);

async function reset(page: import("@playwright/test").Page) {
  await page.request.post("/api/workspace", { data: { action: "reset", commandId: `reset-${Date.now()}` } });
  await page.goto("/");
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByText("Project state: empty")).toBeVisible();
}

async function addPastedMaterial(page: import("@playwright/test").Page, text = "Atelier helps teams recover two days of client presentation preparation.") {
  await page.getByLabel("Paste source text").fill(text);
  await page.getByRole("button", { name: "Add material" }).click();
  await expect(page.getByText("Project state: materials ready")).toBeVisible();
}

test.beforeEach(async ({ page }) => reset(page));

test("material to reviewed understanding to explicit acceptance", async ({ page }) => {
  await addPastedMaterial(page);
  await page.getByRole("button", { name: "Run understanding agent" }).click();
  await expect(page.getByText("Project state: review required")).toBeVisible();
  await expect(page.getByText("Exact source quote")).toBeVisible();

  await page.getByLabel("Answer the agent’s question").fill("Approve the twelve-team expansion pilot.");
  await page.getByRole("button", { name: "Save answer & reassess" }).click();
  await expect(page.getByText("Approve the twelve-team expansion pilot.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Review the proposed changes" })).toBeVisible();
  await page.getByRole("button", { name: "Apply changes to understanding" }).click();
  await expect(page.getByText("Understanding v2")).toBeVisible();

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
  await expect(page.locator(".actionRecovery[role=alert]")).toBeVisible();
  await page.getByText("Technical details").click();
  await expect(page.locator(".actionRecovery[role=alert]")).toContainText("Choose a UTF-8 .txt or .md file.");
  await page.getByRole("button", { name: "Review current step" }).click();
  await page.locator("#material-file").setInputFiles(fixture("source-a.md"));
  await expect(page.locator(".actionRecovery[role=alert]")).toHaveCount(0);
  await expect(page.getByText("source-a.md", { exact: true })).toBeVisible();
  await expect(page.getByText("Project state: materials ready")).toBeVisible();
});

test("stale second tab fails closed and can refresh", async ({ page, context }) => {
  await addPastedMaterial(page);
  await page.getByRole("button", { name: "Run understanding agent" }).click();
  await expect(page.getByText("Project state: review required")).toBeVisible();

  const stalePage = await context.newPage();
  await stalePage.route("**/api/workspace/events", (route) => route.abort());
  await stalePage.goto("/");
  await stalePage.getByRole("button", { name: "Clarify", exact: true }).click();
  await expect(stalePage.getByText("Understanding v1")).toBeVisible();

  await page.getByRole("button", { name: "Clarify", exact: true }).click();
  await page.getByLabel("Your correction").fill("Current correction from tab one.");
  await page.getByRole("button", { name: "Record correction" }).click();
  await expect(page.getByText("Understanding v2")).toBeVisible();

  await stalePage.getByLabel("Your correction").fill("Stale correction from tab two.");
  await stalePage.getByRole("button", { name: "Record correction" }).click();
  await expect(stalePage.locator(".actionRecovery[role=alert]")).toBeVisible();
  await stalePage.reload();
  await stalePage.getByRole("button", { name: "Clarify", exact: true }).click();
  await expect(stalePage.getByText("Understanding v2")).toBeVisible();
  await stalePage.close();
});

test("workspace survives an event-stream disconnect and reload", async ({ page }) => {
  await page.route("**/api/workspace/events", (route) => route.abort());
  await addPastedMaterial(page);
  await page.getByRole("button", { name: "Run understanding agent" }).click();
  await expect(page.getByText("Project state: review required")).toBeVisible();
  await page.unroute("**/api/workspace/events");
  await page.reload();
  await expect(page.getByText("Project state: review required")).toBeVisible();
  await page.getByRole("button", { name: "Clarify", exact: true }).click();
  await expect(page.getByText("Exact source quote")).toBeVisible();
});

test("complete local loop creates, edits, versions, and stales a discussion deck", async ({ page }) => {
  await addPastedMaterial(page);
  await page.getByRole("button", { name: /Run understanding agent/ }).click();
  await page.getByRole("button", { name: /Accept version/ }).click();
  await page.getByRole("button", { name: /Continue to Positioning/ }).click();
  await page.getByRole("button", { name: /Create positioning directions/ }).click();
  await expect(page.getByText("Agent recommendation")).toBeVisible();
  await expect(page.getByRole("heading", { name: "I recommend: Evidence first" })).toBeVisible();
  await expect(page.getByText("The Agent gives a judgment. You still decide what to edit or Apply.")).toBeVisible();
  await page.getByRole("button", { name: /Evidence first/ }).click();
  await page.getByRole("button", { name: "Use this direction" }).click();
  await page.getByRole("button", { name: "Review deck inputs" }).click();
  await page.getByRole("button", { name: "Confirm & create deck" }).click();
  await expect(page.getByRole("heading", { name: "Draft 1" })).toBeVisible();
  await expect(page.getByRole("button", { name: "What supports it" })).toBeVisible();
  await page.getByRole("button", { name: "Edit this page" }).click();
  await page.getByLabel("Page title").fill("Edited positioning");
  await page.getByLabel("Page content").fill("A user-edited discussion point.");
  await page.getByRole("button", { name: "Save as new draft" }).click();
  await expect(page.getByRole("heading", { name: "Draft 2" })).toBeVisible();
  await expect(page.getByText("Edited by you")).toBeVisible();
  await page.getByRole("button", { name: "Materials" }).click();
  await page.getByRole("button", { name: /Add files/ }).click();
  await page.locator("#upload-material-file").setInputFiles(fixture("source-a.md"));
  await page.getByRole("button", { name: "Deck" }).click();
  await expect(page.getByText("This deck is out of date.")).toBeVisible();
});

test("existing project upload modal recovers from invalid type without reload",async({page})=>{
 await addPastedMaterial(page);
 await page.getByRole("button",{name:"Add files"}).click();
 await page.locator("#upload-material-file").setInputFiles(fixture("unsupported.json"));
 await expect(page.getByRole("dialog",{name:"Add source material"})).toHaveCount(0);
 await expect(page.locator('.actionRecovery[role=alert]')).toBeVisible();
 await page.getByRole("button",{name:"Review current step",exact:true}).click();
 await page.getByRole("button",{name:"Add files"}).click();
 await page.locator("#upload-material-file").setInputFiles(fixture("source-b.md"));
 await expect(page.getByText("source-b.md",{exact:true})).toBeVisible();
 await expect(page.getByText("2 files",{exact:true})).toBeVisible();
 await expect(page.getByRole("dialog",{name:"Add source material"})).toHaveCount(0);
});
