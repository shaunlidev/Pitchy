import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { planPrune, selectCandidates } from './maintain-evidence';

describe('evidence maintenance', () => {
  test('selects exact report duplicates and screenshots but never original traces', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'pitchroom-evidence-'));
    const original = resolve(root, 'run/test-results/case/trace.zip');
    const duplicate = resolve(root, 'run/playwright-report/data/copy.zip');
    const other = resolve(root, 'run/playwright-report/data/other.zip');
    const screenshot = resolve(root, 'run/screenshot.png');
    for (const path of [original, duplicate, other, screenshot]) mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(original, 'trace'); writeFileSync(duplicate, 'trace'); writeFileSync(other, 'different'); writeFileSync(screenshot, 'png');
    const files = [original, duplicate, other, screenshot].map(path => ({ path, bytes: 5, mtimeMs: 1 }));
    const selected = selectCandidates(files);
    expect(selected.map(file => file.path)).toEqual([duplicate, screenshot]);
    expect(selected.some(file => file.path === original)).toBe(false);
  });

  test('stops selecting once the target is reached', () => {
    const candidates = [60, 50, 40].map((bytes, index) => ({ path: String(index), bytes, mtimeMs: index, kind: 'archived_screenshot' as const, reason: 'test' }));
    const plan = planPrune(400, candidates, 300);
    expect(plan.selected.map(file => file.bytes)).toEqual([60, 50]);
    expect(plan.projectedBytes).toBe(290);
  });
});
