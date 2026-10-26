import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { addFixtureMaterial, resetFixtureState, runFixtureAgent } from '../../apps/web/lib/fixture-store';
import { workspaceCommandSchema } from '../../apps/web/lib/api-contract';
import { newClarification, buildClarificationCandidate, understandingProposalV1Schema } from '../../packages/domain/src/index';
import { DeterministicClarificationRunner, evaluateClarification } from '../../packages/agent/src/clarification-runner';

async function main() {
const require = createRequire(resolve('apps/web/package.json'));
const { chromium, expect } = require('@playwright/test');
const url = 'http://127.0.0.1:44222';
const checks: Record<string, string> = {};
resetFixtureState();
addFixtureMaterial({ name: 'synthetic.md', mediaType: 'text/markdown', text: 'Atelier helps design teams prepare presentations. The measurement baseline and timing are unknown.' });
const state = runFixtureAgent();
const version = state.versions.find(v => v.id === state.currentVersionId)!;
const question = (text: string, themeIndex: number) => ({ question: text, whyItMatters: 'This unresolved choice affects the discussion.', relatedThemeIndexes: [themeIndex] });
version.proposal.themes = ['Audience', 'Measurement', 'Timing'].map(title => ({ title, summary: `${title} is unknown.`, claims: [{ statement: `${title} is unknown.`, evidenceState: 'unknown', evidence: [], userInputIds: [] }] }));
version.proposal.gaps = [{ description: 'Measurement baseline missing', whyItMatters: 'The reported target cannot be assessed without a baseline.', relatedSourceIds: [] }];
version.proposal.nextQuestion = question('Who is the audience?', 0);
version.proposal.topicTasks = [
  { id: 'audience', themeIndex: 0, question: question('Who is the audience?', 0) },
  { id: 'measurement', themeIndex: 1, relatedGapIndexes: [0], question: question('How will the target be measured?', 1) },
];
version.proposal = understandingProposalV1Schema.parse(version.proposal);
const server = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'dev', '-H', '127.0.0.1', '-p', '44222'], {
  cwd: resolve('apps/web'), env: { ...process.env, PITCHROOM_RUNTIME: 'fixture', PITCHROOM_ISOLATED_QA: '1', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout?.on('data', b => { serverLog = (serverLog + b).slice(-12000); });
server.stderr?.on('data', b => { serverLog = (serverLog + b).slice(-12000); });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  const deadline = Date.now() + 60000;
  while (true) {
    if (server.exitCode !== null) throw new Error(`Isolated server exited: ${serverLog}`);
    try { if ((await fetch(url)).ok) break; } catch { /* Startup only, bounded below. */ }
    if (Date.now() > deadline) throw new Error(`Isolated server did not become ready: ${serverLog}`);
    await new Promise(r => setTimeout(r, 250));
  }
  browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  let submission: ReturnType<typeof newClarification> | undefined;
  let commandCount = 0;
  await page.route('**/api/workspace/events', route => route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': isolated synthetic UI boundary\n\n' }));
  await page.route('**/api/workspace', async route => {
    if (route.request().method() === 'POST') {
      const body = workspaceCommandSchema.parse(route.request().postDataJSON());
      commandCount++;
      if (body.action === 'submit_clarification') {
        submission = newClarification({ id: 'browser-answer', inputId: 'browser-input', projectId: state.project.id, commandId: body.commandId, actorId: 'synthetic', versionId: version.id, revision: state.project.revision, base: version.proposal, sources: [], answer: body.text, selection: body.selection });
      } else if (body.action === 'keep_unknown') {
        assert.equal(body.expectedRevision, state.project.revision);
        const current = state.versions.find(v => v.id === state.currentVersionId)!;
        const next = { ...structuredClone(current), id: 'unknown-preserved', number: current.number + 1, createdBy: 'user' as const };
        state.versions.push(next); state.currentVersionId = next.id; state.project.revision++;

      } else throw new Error(`Unexpected UI mutation ${body.action}`);
    }
    await route.fulfill({ json: state });
  });
  await page.goto(url);
  await page.getByRole('button', { name: 'Clarify', exact: true }).click();
  const overview = page.locator('.projectMap details');
  await expect(overview).not.toHaveAttribute('open', '');
  await expect(page.locator('.evidenceDisclosure')).not.toHaveAttribute('open', '');
  await expect(page.locator('.understandingSummary')).not.toHaveAttribute('open', '');
  const select = async (name: string) => { await overview.locator('summary').click(); await page.getByRole('button', { name, exact: false }).click(); };
  await select('Open question 1');
  await expect(page.locator('.focusedQuestion h2')).toHaveText('How will the target be measured?');
  await page.getByLabel('Answer the agent’s question').fill('Measurement draft A');
  await select('Audience');
  await expect(page.locator('.focusedQuestion h2')).toHaveText('Who is the audience?');
  await expect(page.getByLabel('Answer the agent’s question')).toHaveValue('');
  await page.getByLabel('Answer the agent’s question').fill('Audience draft B');
  await select('Measurement');
  await expect(page.getByLabel('Answer the agent’s question')).toHaveValue('Measurement draft A');
  await page.reload();
  await expect(page.getByLabel('Answer the agent’s question')).toHaveValue('Measurement draft A');
  checks['recovery-browser'] = 'A → B → A and reload preserve separately scoped drafts.';
  await page.getByRole('button', { name: 'Save answer & reassess', exact: true }).click();
  await expect.poll(() => submission?.answer).toBe('Measurement draft A');
  assert.equal(submission?.selection?.themeIndex, 1);
  assert.equal(submission?.question.question, 'How will the target be measured?');
  assert.equal(state.clarifications?.length, 0);
  checks['normal-browser'] = 'Gap selection emits A task identity and A draft at the validated domain boundary; preview has not been applied.';
  const before = structuredClone(version.proposal);
  await page.getByRole('button', { name: 'Keep unknown' }).click();
  await expect.poll(() => commandCount).toBe(2);
  assert.deepEqual(version.proposal, before);
  await expect(page.locator('.focusedQuestion h2')).toHaveText('How will the target be measured?');
  checks['refusal-browser'] = 'Not sure yet leaves the selected topic/question and unknowns intact at the synthetic UI boundary.';
  await select('Timing');
  await expect(page.locator('.focusedQuestion h2')).toHaveText('No question is linked to this topic yet.');
  await expect(page.getByLabel('Answer the agent’s question')).toHaveCount(0);
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(overview).not.toHaveAttribute('open', '');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  checks['failure-and-mobile-browser'] = 'No-task topic offers material/unknown state; mobile overview is collapsed and has no horizontal overflow.';
  // Exercise the actual runner as well as the browser's isolated network boundary.
  // This must fail while the synthetic runner still hard-codes theme zero.
  assert.ok(submission);
  const output = await evaluateClarification(submission, new DeterministicClarificationRunner());
  assert.ok(output.result.operations.some(op => op.type === 'add_answer' && op.themeId === submission!.base.themes[1]!.id));
  const candidate = buildClarificationCandidate(submission, output.result);
  assert.deepEqual(candidate.themes[0], submission.base.themes[0]);
  checks['runner'] = 'Actual deterministic runner preserves selected-topic attribution.';
  console.log(JSON.stringify({ passed: true, checks, boundary: 'Isolated browser with intercepted synthetic workspace responses; no database, model, recording or deployment.' }));
} catch (error) {
  console.log(JSON.stringify({ passed: false, checks, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await Promise.race([once(server, 'exit'), new Promise(r => setTimeout(r, 5000))]);
  if (server.exitCode === null) { server.kill('SIGKILL'); await once(server, 'exit'); }
}

}
main().catch(error => { console.error(error); process.exitCode = 1; });
