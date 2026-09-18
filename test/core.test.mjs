import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLib } from './harness.mjs';

const worktree = await loadLib('worktree');
const pipeline = await loadLib('pipeline');
const verify = await loadLib('verify');

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'boost-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'user.name', 'boost-test');
  git('config', 'user.email', 'boost@localhost');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'tests'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'boost-fixture', version: '1.0.0', type: 'module', scripts: { test: 'node --test tests/*.test.js' } }));
  writeFileSync(join(dir, 'math.js'), 'export function add(a, b) { return a + b; }\nexport function divide(a, b) { return a / b; }\n');
  writeFileSync(join(dir, 'tests', 'math.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { divide } from '../math.js';\ntest('divide', () => assert.equal(divide(4, 2), 2));\n");
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return { dir, git };
}

describe('worktree: ephemeral isolation', () => {
  it('creates an isolated worktree on a boost branch', () => {
    const { dir } = makeRepo();
    const created = worktree.createRun(dir, { task: 'fix the divide-by-zero case' });
    assert.equal(created.ok, true);
    // Windows `path.join` yields backslashes; assert on the platform separator
    // instead of a hardcoded forward slash.
    const expected = join('.dsh-boost', 'worktrees');
    assert.ok(created.state.worktree.includes(expected), `worktree must live under ${expected}: ${created.state.worktree}`);
    assert.match(created.state.branch, /^boost\//);
    assert.equal(worktree.isGitRepo(created.state.worktree), true);
  });

  it('rejects a non-git workspace with an actionable reason', () => {
    const plain = mkdtempSync(join(tmpdir(), 'boost-plain-'));
    const created = worktree.createRun(plain, { task: 'x' });
    assert.equal(created.ok, false);
    assert.match(created.reason, /not a git repository/i);
  });

  it('main repo is untouched while the run edits the worktree', () => {
    const { dir } = makeRepo();
    const created = worktree.createRun(dir, { task: 'edit math' });
    writeFileSync(join(created.state.worktree, 'math.js'), 'export function divide(a, b) { if (b === 0) throw new Error("zero"); return a / b; }\n');
    const main = execFileSync('git', ['-C', dir, 'diff', '--name-only'], { encoding: 'utf8' }).trim();
    assert.equal(main, '', 'main worktree must show no diff');
  });

  it('diff summary reports the changed files', () => {
    const { dir } = makeRepo();
    const created = worktree.createRun(dir, { task: 'edit math' });
    writeFileSync(join(created.state.worktree, 'math.js'), 'export function divide(a, b) { return b === 0 ? 0 : a / b; }\n');
    const diff = worktree.worktreeDiff(dir, created.state.runId);
    assert.equal(diff.ok, true);
    assert.ok(diff.files.includes('math.js'));
  });
});

describe('verify: local verification and diagnostics', () => {
  it('passes when the command exits 0', () => {
    const r = verify.runCommand('node -e ""', { cwd: tmpdir() });
    assert.equal(r.passed, true);
    assert.equal(r.exitCode, 0);
  });

  it('captures diagnostics on failure', () => {
    const r = verify.runCommand('node -e "process.exit(3)"', { cwd: tmpdir() });
    assert.equal(r.passed, false);
    assert.equal(r.exitCode, 3);
  });

  it('reports spawn errors instead of throwing', () => {
    const r = verify.runCommand('definitely-not-a-command-xyz', { cwd: tmpdir() });
    assert.equal(r.passed, false);
    assert.ok(r.diagnostics.length > 0, 'diagnostics must explain what went wrong');
  });

  it('round stops at the first failure and returns its diagnostics', () => {
    const dir = mkdtempSync(join(tmpdir(), 'boost-round-'));
    const round = verify.runRound(['node -e ""', 'node -e "console.error(\'boom\'); process.exit(1)"', 'node -e ""'], { cwd: dir });
    assert.equal(round.passed, false);
    assert.equal(round.results.length, 2, 'third command never runs after a failure');
    assert.match(round.diagnostics, /boom/);
  });
});

describe('pipeline: three phases and the feedback loop', () => {
  it('plan rejects an empty task', () => {
    const planned = pipeline.plan('   ');
    assert.equal(planned.ok, false);
  });

  it('plan produces both official workstream kinds', () => {
    const planned = pipeline.plan('fix the race condition');
    assert.equal(planned.ok, true);
    const kinds = planned.workstreams.map((w) => w.kind).sort();
    assert.deepEqual(kinds, ['implementation', 'investigation']);
  });

  it('rejects an investigation workstream that reports file changes', () => {
    const { dir } = makeRepo();
    const created = worktree.createRun(dir, { task: 'investigate deadlock' });
    const rejected = pipeline.report(dir, created.state.runId, {
      kind: 'investigation',
      summary: 'root cause found',
      files: ['src/lock.js'],
    });
    assert.equal(rejected.ok, false);
    assert.match(rejected.reason, /must not modify files/i);
  });

  it('accepts an investigation workstream with no file changes', () => {
    const { dir } = makeRepo();
    const created = worktree.createRun(dir, { task: 'investigate deadlock' });
    const accepted = pipeline.report(dir, created.state.runId, {
      kind: 'investigation',
      summary: 'lock acquired before await; released after',
      files: [],
    });
    assert.equal(accepted.ok, true);
  });

  it('fails a round and returns feedback with diagnostics', () => {
    const { dir } = makeRepo();
    const created = worktree.createRun(dir, { task: 'verify loop', verifyCommands: ['node -e "process.exit(1)"'] });
    const outcome = pipeline.iterate(dir, created.state.runId);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.status, 'iterating');
    assert.equal(outcome.failedCommand, 'node -e "process.exit(1)"');
    assert.ok(outcome.feedback.includes('diagnostics'), 'feedback must carry diagnostics for the next iteration');
  });

  it('delivers when a round passes', () => {
    const { dir } = makeRepo();
    const created = worktree.createRun(dir, { task: 'verify loop', verifyCommands: ['node -e ""'] });
    const outcome = pipeline.iterate(dir, created.state.runId);
    assert.equal(outcome.status, 'delivered');
  });

  it('escalates to needs_review once maxRounds are exhausted', () => {
    const { dir } = makeRepo();
    const created = worktree.createRun(dir, { task: 'broken', verifyCommands: ['node -e "process.exit(1)"'] });
    const state = worktree.readState(dir, created.state.runId);
    state.maxRounds = 2;
    worktree.writeState(dir, state);
    let outcome;
    for (let i = 0; i < 2; i++) outcome = pipeline.iterate(dir, created.state.runId);
    assert.equal(outcome.status, 'needs_review');
    assert.match(outcome.feedback, /human review/i);
  });

  it('refuses to deliver a run that has not passed every round', () => {
    const { dir } = makeRepo();
    const created = worktree.createRun(dir, { task: 'fail run', verifyCommands: ['node -e "process.exit(1)"'] });
    pipeline.iterate(dir, created.state.runId);
    const closed = worktree.closeRun(dir, created.state.runId);
    assert.equal(closed.ok, false);
    assert.equal(closed.merged, false);
    assert.ok(closed.worktree, 'unverified worktree is kept for inspection');
  });

  it('merges verified changes and removes the ephemeral worktree', () => {
    const { dir, git } = makeRepo();
    const created = worktree.createRun(dir, { task: 'safe fix', verifyCommands: ['node -e ""'] });
    writeFileSync(join(created.state.worktree, 'math.js'), 'export function add(a, b) { return a + b; }\nexport function divide(a, b) { if (b === 0) throw new Error("zero"); return a / b; }\n');
    execFileSync('git', ['-C', created.state.worktree, 'add', '-A'], { stdio: 'ignore' });
    execFileSync('git', ['-C', created.state.worktree, 'commit', '-q', '-m', 'fix divide'], { stdio: 'ignore' });
    pipeline.iterate(dir, created.state.runId, { verifyCommands: ['node -e ""'] });
    const closed = worktree.closeRun(dir, created.state.runId);
    assert.equal(closed.ok, true, closed.reason);
    assert.equal(closed.merged, true);
    const merged = execFileSync('git', ['-C', dir, 'show', 'HEAD:math.js'], { encoding: 'utf8' });
    assert.match(merged, /zero/, 'verified change must be merged into the target branch');
  });
});
