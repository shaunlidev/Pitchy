/** Bounded, offline documentation capture. Not a replacement for the v6 regression suite. */
import { chromium, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { evidenceUsage } from './workspace';

const root = resolve(import.meta.dir, '..');
const source = 'prototype/index.html';
const script = 'harness/capture.ts';
const run = process.env.PITCHROOM_DOCS_RUN;
if (!run || !/^[a-zA-Z0-9-]+$/.test(run)) throw new Error('Set a new PITCHROOM_DOCS_RUN identifier.');
const out = resolve(root, 'evidence/runs', run);
const hash = (path: string) => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
const used = () => evidenceUsage(root, manifest).reduce((n, entry) => n + entry.bytes, 0);
const cap = 320_000_000, reserve = 2_000_000, maintenanceThreshold = 300_000_000;
let beforeBytes = used();
if (beforeBytes >= maintenanceThreshold) {
  const maintenance = spawnSync(process.execPath, [resolve(root, 'harness/maintain-evidence.ts'), '--apply'], { cwd: root, stdio: 'inherit' });
  if (maintenance.error || maintenance.status !== 0) throw new Error('BLOCKED_BUDGET: automatic evidence maintenance did not create enough safe capacity.');
  beforeBytes = used();
}
if (beforeBytes + reserve > cap) throw new Error('BLOCKED_BUDGET: preserve existing evidence; obtain a capacity decision.');
if (existsSync(out)) throw new Error('Refusing to overwrite an existing evidence directory.');
const prior = JSON.parse(readFileSync(resolve(root, 'evidence/runs/2026-10-11-mockup-v6-02/result.json'), 'utf8'));
expect(hash(source)).toBe(prior.htmlHash);
mkdirSync(out);
const browser = await chromium.launch({ executablePath: process.env.PITCHROOM_CHROMIUM_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, offline: true, serviceWorkers: 'block', reducedMotion: 'reduce' });
const errors: string[] = [], external: string[] = [], screenshots: object[] = [];
await context.route('**/*', route => route.request().url().startsWith('file:') ? route.continue() : (external.push(route.request().url()), route.abort()));
await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
page.setDefaultTimeout(8000);
const click = (name: string) => page.getByRole('button', { name, exact: true }).click();
const capture = async (id: string, state: string) => {
  await page.evaluate(() => document.fonts.ready);
  await page.locator('#toast').waitFor({ state: 'hidden' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  const file = `${id}.png`;
  const png = await page.screenshot({ path: resolve(out, file), animations: 'disabled', fullPage: true });
  screenshots.push({ id, file, state, viewport: { width: 1280, height: 800 }, capture: 'fullPage', pixels: { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }, sha256: hash(resolve(out, file)) });
};
let status = 'failed';
try {
  await page.goto('file://' + resolve(root, source));
  await click('Open sample project');
  await page.getByRole('navigation', { name: 'Project workspace' }).getByRole('button', { name: 'Positioning', exact: true }).click();
  await click('Taste first');
  await click('Preview the impact');
  await click('Use this change');
  await expect(page.locator('.paper')).toContainText('THE SNACK YOU WANT.');
  await capture('07-positioning', 'Taste-first judgment applied; working direction, before/after and generation action.');
  await click('Compare directions');
  await expect(page.locator('.direction-card')).toHaveCount(3);
  await capture('08-direction-comparison', 'Three proposed directions and trade-offs; no choice is made by opening this dialog.');
  await click('Close dialog');
  await click('Use direction & create deck');
  await expect(page.getByRole('navigation', { name: 'Deck pages' }).getByRole('button')).toHaveCount(5);
  await capture('09-deck', 'Five-page discussion deck, first page and revision controls.');
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
  status = 'passed';
} finally {
  await context.tracing.stop({ path: resolve(out, 'documentation-capture.trace.zip') });
  await browser.close();
  const afterBytes = used();
  if (afterBytes > cap || afterBytes - beforeBytes > reserve) status = 'failed';
  const result = { status, purpose: 'Additional section screenshots only; not a regression rerun.', source, htmlHash: hash(source), script, scriptHash: hash(script), errors, external, screenshots, beforeBytes, afterBytesBeforeResult: afterBytes, reservedBytes: reserve, approvedCap: cap };
  writeFileSync(resolve(out, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  if (status !== 'passed') process.exitCode = 1;
}
