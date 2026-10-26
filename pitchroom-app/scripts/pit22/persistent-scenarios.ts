import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { createDatabase, PitchroomRepository, ClarificationRepository } from '../../packages/persistence/src/index';
import { understandingProposalV1Schema } from '../../packages/domain/src/index';
import { workspaceStateSchema } from '../../apps/web/lib/api-contract';

async function main() {
  // Public dedicated test credentials from the existing verification guide.
  // Do not load an environment file or accept an arbitrary database target.
  const databaseUrl = process.env.PITCHROOM_QA_DATABASE_URL;
  assert.ok(databaseUrl, 'Explicit dedicated synthetic PITCHROOM_QA_DATABASE_URL is required.');
  const target = new URL(databaseUrl);
  assert.equal(target.hostname, '127.0.0.1'); assert.equal(target.port, '55437');
  assert.equal(target.username, 'clarify_qa'); assert.equal(target.pathname, '/clarify_qa');
  assert.equal(target.search + target.hash, '');
  const require = createRequire(resolve('apps/web/package.json'));
  const { chromium, expect } = require('@playwright/test');
  const url = 'http://127.0.0.1:44223';
  const database = createDatabase(databaseUrl);
  const repo = new PitchroomRepository(database.db);
  const lease = await database.client.reserve();
  const checks: Record<string, string> = {};
  const ownedSlug = `pit22-http-${crypto.randomUUID()}`;
  let priorId: string | undefined;
  let projectId: string | undefined;
  let ownsLease = false;
  let server: ChildProcess | undefined;
  let serverLog = '';
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    DATABASE_URL: databaseUrl, PITCHROOM_RUNTIME: 'postgres-fake', PITCHROOM_ISOLATED_QA: '1', NEXT_TELEMETRY_DISABLED: '1' };
  async function stopServer() {
    const child = server; server = undefined;
    if (!child || child.exitCode !== null) return;
    const exited = once(child, 'exit'); child.kill('SIGTERM');
    await Promise.race([exited, new Promise(r => setTimeout(r, 5000))]);
    if (child.exitCode === null) { child.kill('SIGKILL'); await exited; }
  }
  async function read() {
    const response = await fetch(`${url}/api/workspace`, { signal: AbortSignal.timeout(5000) });
    if (response.status !== 200) throw new Error(`Workspace HTTP ${response.status}: ${await response.text()}`);
    const state = workspaceStateSchema.parse(await response.json());
    assert.equal(state.project.id, projectId, 'HTTP runtime must use the owned synthetic project.');
    assert.equal(state.mode, 'postgres-fake');
    return state;
  }
  async function post(body: unknown, expectedStatus: number) {
    const response = await fetch(`${url}/api/workspace`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    if (response.status !== expectedStatus) throw new Error(`Expected HTTP ${expectedStatus}, got ${response.status}: ${await response.text()}`);
    return response.json();
  }
  async function startServer() {
    server = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'dev', '-H', '127.0.0.1', '-p', '44223'], { cwd: resolve('apps/web'), env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout?.on('data', chunk => { serverLog = (serverLog + chunk).slice(-4000); });
    server.stderr?.on('data', chunk => { serverLog = (serverLog + chunk).slice(-4000); });
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      assert.equal(server.exitCode, null, `Owned HTTP service exited: ${serverLog}`);
      let healthy = false;
      try { healthy = (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { /* Bounded startup only. */ }
      if (healthy) { await read(); return; }
      await new Promise(r => setTimeout(r, 250));
    }
    throw new Error(`Owned HTTP service did not become ready: ${serverLog}`);
  }
  try {
    const [identity] = await lease`select current_database() as database, current_user as username, pg_try_advisory_lock(22055437) as locked`;
    assert.equal(identity?.database, 'clarify_qa'); assert.equal(identity?.username, 'clarify_qa');
    ownsLease = identity?.locked === true;
    assert.ok(ownsLease, 'The dedicated synthetic HTTP fixture is in use; do not overlap or alter another run.');
    const [schemaReady] = await lease`select to_regclass('public.topic_materials') as table_name`;
    assert.ok(schemaReady?.table_name, 'Dedicated clarify_qa database lacks required public.topic_materials. Persistent HTTP cannot load. No migration/schema change is authorized by this check.');
    // The app has one fixed local slug. Temporarily park that synthetic alias,
    // retain every row/history, then restore it after stopping our own runtime.
    const [prior] = await lease`select id from projects where slug = 'atelier'`;
    priorId = prior?.id;
    if (priorId) await lease`update projects set slug = ${ownedSlug + '-parked'} where id = ${priorId} and slug = 'atelier'`;
    const project = await repo.ensureProject('atelier', `Synthetic PIT-22 persisted HTTP ${ownedSlug}`);
    assert.ok(project); projectId = project.id;
    await repo.addMaterial(project.id, { name: 'synthetic.md', mediaType: 'text/markdown', text: 'Synthetic pilot: the audience is undecided. The measurement baseline and timing remain unknown.' }, crypto.randomUUID());
    const source = (await repo.listSources(project.id))[0]!;
    const chunk = source.chunks[0]!;
    const question = (text: string, themeIndex: number) => ({ question: text, whyItMatters: 'This explicitly unresolved choice affects the synthetic pilot discussion.', relatedThemeIndexes: [themeIndex] });
    const proposal = understandingProposalV1Schema.parse({ schemaVersion: 1,
      themes: [
        { title: 'Audience', summary: 'The intended pilot audience remains undecided.', claims: [{ statement: 'The record describes an undecided audience.', evidenceState: 'supported', evidence: [{ sourceId: source.id, chunkId: chunk.id, quote: 'the audience is undecided' }] }] },
        ...['Measurement', 'Timing'].map(title => ({ title, summary: `${title} remains unknown.`, claims: [{ statement: `${title} is unknown.`, evidenceState: 'unknown', evidence: [] }] })),
      ],
      gaps: [{ description: 'Measurement baseline missing', whyItMatters: 'An evaluation needs a comparison baseline.', relatedSourceIds: [source.id] }],
      nextQuestion: question('Who is the intended pilot audience?', 0),
      topicTasks: [{ id: 'audience', themeIndex: 0, question: question('Who is the intended pilot audience?', 0) }, { id: 'measurement', themeIndex: 1, relatedGapIndexes: [0], question: question('What is the current measurement baseline?', 1) }],
    });
    const run = await repo.createRun(project.id, crypto.randomUUID(), 'pit22-http-synthetic', 'deterministic-local');
    await repo.completeRun({ projectId: project.id, runId: run.id, expectedRevision: project.version, proposal });
    await startServer();
    browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    await page.goto(url);
    await page.getByRole('button', { name: 'Clarify', exact: true }).click();
    const overview = page.locator('.projectMap details');
    const select = async (name: string) => { await overview.locator('summary').click(); await page.getByRole('button', { name, exact: false }).click(); };
    await select('Open question 1');
    await expect(page.locator('.focusedQuestion h2')).toHaveText('What is the current measurement baseline?');
    await page.getByLabel('Answer the agent’s question').fill('Measurement draft before returning from gap.');
    await page.getByRole('button', { name: 'Back to the current useful question' }).click();
    await expect(page.locator('.focusedQuestion h2')).toHaveText('What is the current measurement baseline?');
    await expect(page.getByLabel('Answer the agent’s question')).toHaveValue('Measurement draft before returning from gap.');
    await page.getByLabel('Answer the agent’s question').fill('');
    checks['return-preserves-selected-task'] = 'Returning from a non-first topic gap keeps the same task/question and its unsent draft.';
    await expect(page.locator('.evidenceDisclosure')).not.toHaveAttribute('open', '');
    await expect(page.locator('.understandingSummary')).not.toHaveAttribute('open', '');
    await page.getByText('Why this matters', { exact: true }).click();
    await expect(page.locator('.questionRationale')).toHaveAttribute('open', '');
    checks['normal-topic-and-disclosure'] = 'Real persisted theme 1 gap displays only its own task; rationale remains inspectable and bulk evidence/summary remain collapsed.';
    const beforeRefusal = await read();
    const refused = page.waitForResponse(response => response.url().endsWith('/api/workspace') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Keep unknown' }).click();
    assert.equal((await refused).status(), 200);
    const afterRefusal = await read();
    assert.notEqual(afterRefusal.currentVersionId, beforeRefusal.currentVersionId);
    assert.deepEqual(afterRefusal.versions.at(-1)!.proposal, beforeRefusal.versions.at(-1)!.proposal);
    assert.equal(afterRefusal.clarifications?.length, 0);
    await expect(page.locator('.focusedQuestion h2')).toHaveText('What is the current measurement baseline?');
    checks['refusal-persisted'] = 'Actual Not sure yet creates a preserved version with identical unknowns and no fabricated answer; selected theme is retained.';
    await select('Audience'); await page.getByLabel('Answer the agent’s question').fill('Audience draft B must not be submitted as measurement.');
    await select('Measurement'); await page.getByLabel('Answer the agent’s question').fill('Measurement draft A: the baseline is still unknown.');
    await select('Audience'); await expect(page.getByLabel('Answer the agent’s question')).toHaveValue('Audience draft B must not be submitted as measurement.');
    await select('Measurement'); await expect(page.getByLabel('Answer the agent’s question')).toHaveValue('Measurement draft A: the baseline is still unknown.');
    await page.reload(); await expect(page.getByLabel('Answer the agent’s question')).toHaveValue('Measurement draft A: the baseline is still unknown.');
    checks['recovery-browser'] = 'Real HTTP browser A/B switching and reload preserve separately scoped drafts.';
    await select('Timing'); await expect(page.locator('.focusedQuestion h2')).toHaveText('No question is linked to this topic yet.');
    await expect(page.getByLabel('Answer the agent’s question')).toHaveCount(0);
    await page.setViewportSize({ width: 375, height: 812 }); await expect(overview).not.toHaveAttribute('open', '');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.setViewportSize({ width: 1280, height: 900 });
    checks['failure-no-task-and-mobile'] = 'No-task topic offers supporting material/unknown state without another topic question; mobile overview collapsed without horizontal overflow.';
    await select('Measurement');
    const before = await read(); const base = before.versions.find(v => v.id === before.currentVersionId)!;
    const selection = { understandingId: base.id, taskId: 'measurement', themeIndex: 1 };
    await post({ action: 'submit_clarification', commandId: crypto.randomUUID(), text: 'Must reject wrong task attribution', expectedRevision: before.project.revision, selection: { ...selection, taskId: 'audience' } }, 409);
    await post({ action: 'submit_clarification', commandId: crypto.randomUUID(), text: 'Must reject stale task', expectedRevision: before.project.revision, selection: { ...selection, understandingId: beforeRefusal.currentVersionId } }, 409);
    assert.equal((await read()).clarifications?.length, 0);
    checks['failure-http-rejection'] = 'Actual API rejects mismatched and stale topic selections with 409 without inserting a task.';
    const submitted = page.waitForResponse(response => response.url().endsWith('/api/workspace') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Save answer & reassess', exact: true }).click();
    assert.equal((await submitted).status(), 202);
    const queued = await read(); const saved = queued.clarifications!.at(-1)!;
    assert.deepEqual(saved.selection, selection); assert.equal(saved.answer, 'Measurement draft A: the baseline is still unknown.');
    assert.equal(saved.question.question, 'What is the current measurement baseline?');
    assert.equal(queued.currentVersionId, before.currentVersionId);
    const worker = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/pit22/scoped-worker.ts', project.id], { cwd: resolve('.'), env, encoding: 'utf8', timeout: 15000 });
    assert.equal(worker.status, 0, worker.stderr);
    const ready = await read(); const readyTask = ready.clarifications!.find(t => t.id === saved.id)!;
    assert.equal(readyTask.status, 'proposal_ready'); assert.equal(ready.currentVersionId, before.currentVersionId);
    assert.deepEqual(readyTask.candidate!.themes[0], readyTask.base.themes[0]);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Review the proposed changes', exact: true })).toBeVisible();
    const appliedResponse = page.waitForResponse(response => response.url().endsWith('/api/workspace') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Apply changes to understanding', exact: true }).click();
    const response = await appliedResponse; assert.equal(response.status(), 200);
    const applyCommand = response.request().postDataJSON();
    const applied = await read(); const result = applied.versions.find(v => v.id === applied.currentVersionId)!;
    assert.equal(result.parentUnderstandingId, base.id); assert.equal(result.clarificationTaskId, saved.id);
    assert.deepEqual(result.proposal.themes[0], readyTask.base.themes[0]);
    assert.ok(result.proposal.themes[1]!.claims.some(c => c.userInputIds.includes(saved.inputId)));
    assert.ok(!result.proposal.themes[0]!.claims.some(c => c.userInputIds.includes(saved.inputId)));
    await post(applyCommand, 200); assert.equal((await read()).versions.length, applied.versions.length);
    checks['worker-explicit-apply-and-lineage'] = 'Real UI submits A, separate project-scoped worker persists proposal, no implicit Apply, actual browser Apply persists exact candidate/lineage only to A, replay is idempotent.';
    await context.close(); await stopServer(); await startServer();
    const fresh = await browser.newContext(); const reopened = await fresh.newPage();
    await reopened.goto(url); await reopened.getByRole('button', { name: 'Clarify', exact: true }).click();
    await reopened.getByText('Saved answer · Before / Now', { exact: true }).click();
    await expect(reopened.getByText('Changes applied · understanding awaits acceptance', { exact: true })).toBeVisible();
    const afterRestart = await read(); assert.equal(afterRestart.currentVersionId, result.id);
    assert.deepEqual(afterRestart.versions.find(v => v.id === result.id)!.proposal, result.proposal);
    const freshDb = createDatabase(databaseUrl);
    try {
      const persisted = (await new ClarificationRepository(freshDb.db).list(project.id)).find(t => t.id === saved.id)!;
      assert.equal(persisted.status, 'applied'); assert.deepEqual(persisted.selection, selection);
      assert.equal(persisted.resultVersionId, result.id);
    } finally { await freshDb.client.end(); }
    await post({ action: 'submit_clarification', commandId: crypto.randomUUID(), text: 'Stale prior answer', expectedRevision: before.project.revision, selection }, 409);
    checks['restart-fresh-client-and-stale-submit'] = 'Cold HTTP service restart, fresh browser and fresh PostgreSQL client read the exact applied state; old revision is rejected.';
    // Preserve and recover a genuinely saved stale answer, not only an unsent draft.
    const recoveryText = '原话：The pilot audience remains unknown.';
    const recoverySaved = workspaceStateSchema.parse(await post({ action: 'submit_clarification', commandId: crypto.randomUUID(), text: recoveryText, expectedRevision: afterRestart.project.revision,
      selection: { understandingId: result.id, taskId: 'audience', themeIndex: 0 } }, 202));
    const staleOriginal = recoverySaved.clarifications!.at(-1)!;
    checks['stale-recovery-answer-saved'] = 'A new actual saved answer exists before making its inputs stale.';
    const inputCount = (await database.client`select count(*) as count from user_inputs where project_id = ${project.id}`)[0]!.count;
    await post({ action: 'add_material', commandId: crypto.randomUUID(), name: 'new-synthetic-context.md', mediaType: 'text/markdown', text: 'Synthetic update: audience and baseline are still undecided.' }, 200);
    const changed = await read();
    assert.equal(changed.clarifications!.find(t => t.id === staleOriginal.id)!.status, 'stale');
    const recoveryProposal = structuredClone(proposal);
    recoveryProposal.themes = [proposal.themes[1]!, proposal.themes[0]!, proposal.themes[2]!];
    recoveryProposal.nextQuestion = question('Which pilot audience is current?', 1);
    recoveryProposal.topicTasks = [
      { id: 'recovery-audience', themeIndex: 1, question: question('Which pilot audience is current?', 1) },
      { id: 'recovery-measurement', themeIndex: 0, relatedGapIndexes: [0], question: question('What baseline should be used now?', 0) },
    ];
    const updatedProject = (await repo.getProject(project.id))!;
    const recoveryRun = await repo.createRun(project.id, crypto.randomUUID(), 'pit22-recovery-synthetic', 'deterministic-local');
    await repo.completeRun({ projectId: project.id, runId: recoveryRun.id, expectedRevision: updatedProject.version, proposal: recoveryProposal });
    const recoveryCurrent = await read();
    const recoverySelection = { understandingId: recoveryCurrent.currentVersionId!, taskId: 'recovery-audience', themeIndex: 1 };
    const rebase = { action: 'submit_clarification', text: recoveryText, expectedRevision: recoveryCurrent.project.revision, rebaseTaskId: staleOriginal.id };
    await post({ ...rebase, commandId: crypto.randomUUID() }, 409);
    await post({ ...rebase, commandId: crypto.randomUUID(), selection: { ...recoverySelection, themeIndex: 0 } }, 409);
    await post({ ...rebase, text: 'Tampered saved answer', commandId: crypto.randomUUID(), selection: recoverySelection }, 409);
    assert.equal((await read()).clarifications!.length, recoveryCurrent.clarifications!.length);
    await reopened.reload();
    const reassessButton = reopened.getByRole('button', { name: 'Reassess against current understanding', exact: true });
    await expect(reassessButton).toBeVisible();
    await expect(reassessButton).toBeDisabled();
    await reopened.getByLabel('Current question for this saved answer').selectOption('1:recovery-audience');
    await expect(reassessButton).toBeEnabled();
    const reassessedResponse = reopened.waitForResponse(response => response.url().endsWith('/api/workspace') && response.request().method() === 'POST');
    await reassessButton.click();
    const reassessedHttp = await reassessedResponse; assert.equal(reassessedHttp.status(), 202);
    const reassessCommand = reassessedHttp.request().postDataJSON();
    const reassessed = (await read()).clarifications!.at(-1)!;
    checks['stale-recovery-queued'] = 'Explicit current ownership reached real HTTP and queued a reassessment.';
    assert.equal(reassessed.inputId, staleOriginal.inputId); assert.equal(reassessed.answer, recoveryText);
    assert.deepEqual(reassessed.selection, recoverySelection);
    assert.equal(reassessed.reassessment!.rebasedFromTaskId, staleOriginal.id);
    assert.equal(reassessed.reassessment!.originalUnderstandingId, staleOriginal.baseUnderstandingId);
    assert.deepEqual(reassessed.reassessment!.originalQuestion, staleOriginal.question);
    assert.equal(reassessed.reassessment!.sourceChanges.added.length, 1);
    assert.equal(reassessed.question.question, 'Which pilot audience is current?');
    assert.equal((await database.client`select count(*) as count from user_inputs where project_id = ${project.id}`)[0]!.count, inputCount);
    const recoveredWorker = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/pit22/scoped-worker.ts', project.id], { cwd: resolve('.'), env, encoding: 'utf8', timeout: 15000 });
    assert.equal(recoveredWorker.status, 0, recoveredWorker.stderr);
    const recoveredReady = await read(); const recoveredTask = recoveredReady.clarifications!.at(-1)!;
    assert.equal(recoveredTask.status, 'proposal_ready'); assert.equal(recoveredReady.currentVersionId, recoveryCurrent.currentVersionId);
    assert.deepEqual(recoveredTask.candidate!.themes[0], recoveredTask.base.themes[0]);
    await reopened.reload();
    await expect(reopened.getByRole('heading', { name: 'Review the proposed changes', exact: true })).toBeVisible();
    const recoveredApply = reopened.waitForResponse(response => response.url().endsWith('/api/workspace') && response.request().method() === 'POST');
    await reopened.getByRole('button', { name: 'Apply changes to understanding', exact: true }).click();
    assert.equal((await recoveredApply).status(), 200);
    const recoveredFinal = await read(); const recoveredVersion = recoveredFinal.versions.find(v => v.id === recoveredFinal.currentVersionId)!;
    assert.equal(recoveredVersion.parentUnderstandingId, recoveryCurrent.currentVersionId);
    assert.equal(recoveredVersion.clarificationTaskId, reassessed.id);
    assert.deepEqual(recoveredVersion.proposal.themes[0], recoveredTask.base.themes[0]);
    assert.ok(recoveredVersion.proposal.themes[1]!.claims.some(c => c.userInputIds.includes(staleOriginal.inputId) && c.statement === recoveryText));
    assert.ok(!recoveredVersion.proposal.themes[0]!.claims.some(c => c.userInputIds.includes(staleOriginal.inputId)));
    await post(reassessCommand, 202);
    assert.equal((await read()).clarifications!.length, recoveredFinal.clarifications!.length);
    checks['stale-answer-explicit-reassessment'] = 'Actual saved stale answer is blocked until explicit current-question selection, then crosses real HTTP, worker and browser Apply after topic reordering/new task IDs. Exact answer/input/original-question/source-change lineage retained, no duplicate user input; other topic unchanged. Missing/wrong selection and tampered saved answer rejected.';
    console.log(JSON.stringify({ passed: true, projectId: project.id, checks, reviewPacket: { source: chunk.text, questions: proposal.topicTasks, newQuestionOperations: readyTask.result!.operations.filter(op => op.type === 'next_question'), retainedTasksAfterApply: result.proposal.topicTasks, recoveryQuestions: recoveryProposal.topicTasks }, boundary: 'Actual local PostgreSQL + unmocked HTTP/browser + separate scoped deterministic worker; no provider, migration, recording or schema change.' }));
  } catch (error) {
    console.log(JSON.stringify({ passed: false, projectId, checks, error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  } finally {
    await browser?.close(); await stopServer();
    if (ownsLease) {
      if (projectId) await lease`update projects set slug = ${ownedSlug} where id = ${projectId} and slug = 'atelier'`;
      if (priorId) await lease`update projects set slug = 'atelier' where id = ${priorId} and slug = ${ownedSlug + '-parked'}`;
      await lease`select pg_advisory_unlock(22055437)`;
    }
    lease.release(); await database.client.end();
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
