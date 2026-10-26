const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');
const cwd = resolve(__dirname, '../..');
const checks = [];
for (const [id, argv] of [
  ['types', ['pnpm', 'typecheck']],
  ['regressions', ['pnpm', 'test']],
  ['persistent-http-browser-worker', [process.execPath, '--import', 'tsx', 'scripts/pit22/persistent-scenarios.ts']],
  ['topic-browser-and-runner', [process.execPath, '--import', 'tsx', 'scripts/pit22/scenarios.ts']],
]) {
  const result = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', timeout: 110000, env: { ...process.env, PITCHROOM_RUNTIME: 'fixture', PITCHROOM_ISOLATED_QA: '1' } });
  const entry = { id, passed: result.status === 0, exitCode: result.status, error: result.error?.message, stdout: result.stdout, stderr: result.stderr };
  checks.push(entry);
}
const passed = checks.every(check => check.passed);
process.stdout.write(JSON.stringify({ passed, checks }));
process.exitCode = passed ? 0 : 1;
