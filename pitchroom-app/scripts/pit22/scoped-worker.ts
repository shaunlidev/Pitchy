import assert from 'node:assert/strict';
import { createDatabase, ClarificationRepository } from '../../packages/persistence/src/index';
import { DeterministicClarificationRunner, evaluateClarification } from '../../packages/agent/src/index';

async function main() {
  const url = process.env.DATABASE_URL;
  assert.ok(url, 'Dedicated synthetic database URL is required.');
  const target = new URL(url);
  assert.equal(target.protocol, 'postgres:');
  assert.equal(target.hostname, '127.0.0.1');
  assert.equal(target.port, '55437');
  assert.equal(target.username, 'clarify_qa');
  assert.equal(target.pathname, '/clarify_qa');
  assert.equal(target.search + target.hash, '');
  const projectId = process.argv[2];
  assert.ok(projectId, 'Scope worker claims to the owned synthetic project.');
  const database = createDatabase(url);
  try {
    const store = new ClarificationRepository(database.db);
    const task = await store.claim('deterministic-local', 'synthetic', projectId);
    assert.ok(task, 'Expected a queued task for this exact project.');
    assert.equal(task.projectId, projectId);
    await store.finish(task, await evaluateClarification(task, new DeterministicClarificationRunner()));
    console.log(JSON.stringify({ passed: true, taskId: task.id, projectId }));
  } finally { await database.client.end(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
