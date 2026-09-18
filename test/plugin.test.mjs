import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolateStateHome, loadPlugin, makeHost, uniqueAgent } from './harness.mjs';

// Keep the plugin's cross-repo active-run registry out of the real ~/.dsh and
// out of other tests' state.
isolateStateHome();

const COMMANDS = ['boost', 'boost-status', 'boost-verify', 'boost-report', 'boost-deliver', 'boost-discard'];
const TOOLS = ['boost_run', 'boost_status', 'boost_verify', 'boost_report', 'boost_deliver'];

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'boostp-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'user.name', 'boost-test');
  git('config', 'user.email', 'boost@localhost');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'f', version: '1.0.0', type: 'module' }));
  writeFileSync(join(dir, 'app.js'), 'export const x = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return dir;
}

/**
 * A stable agent per working directory.
 *
 * Every test builds a fresh repo dir, so memoising by dir gives one stable
 * session id within a test (the open-then-verify flow needs it) while keeping
 * ids unique across tests (so the active-run registry cannot leak state).
 */
const agentsByDir = new Map();
const agentFor = (dir) => {
  let agent = agentsByDir.get(dir);
  if (!agent) {
    agent = uniqueAgent(dir);
    agentsByDir.set(dir, agent);
  }
  return agent;
};

describe('plugin: registration', () => {
  it('exports the Cordis surface', async () => {
    const mod = await loadPlugin();
    assert.equal(mod.name, 'dsh-antigravity-boost');
    assert.equal(typeof mod.apply, 'function');
    assert.ok(mod.Config);
  });

  it('registers all six commands and five tools', async () => {
    const mod = await loadPlugin();
    const { ctx, host } = makeHost();
    mod.apply(ctx, { verifyCommands: ['node -e ""'], maxRounds: 3 });
    for (const c of COMMANDS) assert.ok(host.commands.has(c), `command /${c} must be registered`);
    for (const t of TOOLS) {
      assert.ok(host.tools.has(t), `tool ${t} must be registered`);
      assert.equal(typeof host.tools.get(t).output?.render, 'function', `${t} must declare output.render`);
    }
  });

  it('registers the three-phase usage section including the investigation rule', async () => {
    const mod = await loadPlugin();
    const { ctx, host } = makeHost();
    mod.apply(ctx, { verifyCommands: [] });
    const section = host.sections.get('boost:usage');
    assert.ok(section, 'usage section must exist');
    assert.match(section.text, /Phase 1/);
    assert.match(section.text, /Phase 2/);
    assert.match(section.text, /Phase 3/);
    assert.match(section.text, /MUST\s+NOT\s+modify files/i);
    assert.match(section.text, /current conversation take precedence/i);
  });

  it('registers nothing when disabled', async () => {
    const mod = await loadPlugin();
    const { ctx, host } = makeHost();
    mod.apply(ctx, { enabled: false });
    assert.equal(host.commands.size, 0);
    assert.equal(host.tools.size, 0);
  });
});

describe('plugin: command behaviour', () => {
  it('/boost rejects an empty task', async () => {
    const mod = await loadPlugin();
    const { ctx, host } = makeHost();
    mod.apply(ctx, { verifyCommands: [] });
    const result = host.commands.get('boost').handler({ rawInput: '   ', agent: agentFor(makeRepo()) });
    assert.equal(result.kind, 'error');
  });

  it('/boost opens an ephemeral worktree and states the three phases', async () => {
    const mod = await loadPlugin();
    const { ctx, host } = makeHost();
    mod.apply(ctx, { verifyCommands: ['node -e ""'], maxRounds: 3 });
    const result = host.commands.get('boost').handler({ rawInput: 'fix the divide-by-zero case', agent: agentFor(makeRepo()) });
    assert.equal(result.kind, 'success', result.text);
    assert.match(result.text, /worktree:/);
    assert.match(result.text, /Three-phase protocol/);
  });

  it('/boost-status reports honestly when nothing has run', async () => {
    const mod = await loadPlugin();
    const { ctx, host } = makeHost();
    mod.apply(ctx, { verifyCommands: [] });
    const result = host.commands.get('boost-status').handler({ rawInput: '', agent: agentFor(makeRepo()) });
    assert.equal(result.kind, 'success');
    assert.match(result.text, /no boost run/i);
  });

  it('/boost-verify refuses when no run exists', async () => {
    const mod = await loadPlugin();
    const { ctx, host } = makeHost();
    mod.apply(ctx, { verifyCommands: ['node -e ""'] });
    const result = host.commands.get('boost-verify').handler({ rawInput: '', agent: agentFor(makeRepo()) });
    assert.equal(result.kind, 'error');
  });

  it('/boost-verify reports a passing round and points at delivery', async () => {
    const mod = await loadPlugin();
    const { ctx, host } = makeHost();
    const dir = makeRepo();
    mod.apply(ctx, { verifyCommands: ['node -e ""'], maxRounds: 3 });
    host.commands.get('boost').handler({ rawInput: 'safe change', agent: agentFor(dir) });
    const result = host.commands.get('boost-verify').handler({ rawInput: '', agent: agentFor(dir) });
    assert.equal(result.kind, 'success', result.text);
    assert.match(result.text, /verification passed/i);
  });

  it('/boost-verify returns diagnostics for the next iteration on failure', async () => {
    const mod = await loadPlugin();
    const { ctx, host } = makeHost();
    const dir = makeRepo();
    mod.apply(ctx, { verifyCommands: ['node -e "process.exit(1)"'], maxRounds: 3 });
    host.commands.get('boost').handler({ rawInput: 'broken change', agent: agentFor(dir) });
    const result = host.commands.get('boost-verify').handler({ rawInput: '', agent: agentFor(dir) });
    assert.equal(result.kind, 'success', result.text);
    assert.match(result.text, /diagnostics/i, 'failure must hand diagnostics back for iteration');
  });

  it('/boost-deliver refuses an unverified run', async () => {
    const mod = await loadPlugin();
    const { ctx, host } = makeHost();
    const dir = makeRepo();
    mod.apply(ctx, { verifyCommands: ['node -e "process.exit(1)"'] });
    host.commands.get('boost').handler({ rawInput: 'broken', agent: agentFor(dir) });
    host.commands.get('boost-verify').handler({ rawInput: '', agent: agentFor(dir) });
    const result = host.commands.get('boost-deliver').handler({ rawInput: '', agent: agentFor(dir) });
    assert.equal(result.kind, 'error');
  });

  it('/boost-discard removes the run and reports it', async () => {
    const mod = await loadPlugin();
    const { ctx, host } = makeHost();
    const dir = makeRepo();
    mod.apply(ctx, { verifyCommands: ['node -e ""'] });
    host.commands.get('boost').handler({ rawInput: 'scratch work', agent: agentFor(dir) });
    const result = host.commands.get('boost-discard').handler({ rawInput: '', agent: agentFor(dir) });
    assert.equal(result.kind, 'success', result.text);
    assert.match(result.text, /discarded/i);
  });
});

describe('plugin: cross-repo active-run tracking', () => {
  /**
   * The scenario this exists for: the session cwd is a PARENT folder that is
   * not a git repo (e.g. F:\DPH), and `/boost <repo-path> <task>` creates the
   * run inside the target repo. Follow-up commands must find that run without
   * being re-pointed at the repo.
   */
  function parentDirWithRepo() {
    const parent = mkdtempSync(join(tmpdir(), 'boost-parent-'));
    const repo = join(parent, 'project');
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    mkdirSync(repo, { recursive: true });
    git('init', '-q');
    git('config', 'user.name', 'boost-test');
    git('config', 'user.email', 'boost@localhost');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0', type: 'module' }));
    writeFileSync(join(repo, 'app.js'), 'export const x = 1;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'initial');
    return { parent, repo };
  }

  it('follow-up commands find a run opened with an explicit repo path', async () => {
    const mod = await loadPlugin();
    const { ctx, host } = makeHost();
    const { parent, repo } = parentDirWithRepo();
    const agent = uniqueAgent(parent); // session cwd is the NON-repo parent
    mod.apply(ctx, { verifyCommands: ['node -e ""'], maxRounds: 3 });

    const opened = host.commands.get('boost').handler({ rawInput: `${repo} fix the bug`, agent });
    assert.equal(opened.kind, 'success', opened.text);
    assert.match(opened.text, /Three-phase protocol/);

    // No repo path on the follow-ups — the active-run pointer must resolve it.
    const status = host.commands.get('boost-status').handler({ rawInput: '', agent });
    assert.equal(status.kind, 'success', status.text);
    assert.match(status.text, new RegExp(repo.replace(/\\/g, '\\\\')), 'status must report the target repo');

    const report = host.commands.get('boost-report').handler({ rawInput: 'implementation added the guard', agent });
    assert.equal(report.kind, 'success', report.text);

    const verify = host.commands.get('boost-verify').handler({ rawInput: '', agent });
    assert.equal(verify.kind, 'success', verify.text);
    assert.match(verify.text, /verification passed/i);
  });

  it('a non-repo cwd with no repo path says how to target one', async () => {
    const mod = await loadPlugin();
    const { ctx, host } = makeHost();
    const { parent } = parentDirWithRepo();
    mod.apply(ctx, { verifyCommands: [] });
    const result = host.commands.get('boost').handler({ rawInput: 'do something', agent: uniqueAgent(parent) });
    assert.equal(result.kind, 'error');
    assert.match(result.text, /not a git repository/i);
    // The repo is one level down, so it must be offered as a target.
    assert.match(result.text, /Git repositories available here|repo-path/);
  });

  it('an unrelated session cannot deliver or discard another session run', async () => {
    const mod = await loadPlugin();
    const { ctx, host } = makeHost();
    const { parent, repo } = parentDirWithRepo();
    const owner = uniqueAgent(parent);
    mod.apply(ctx, { verifyCommands: ['node -e ""'] });
    const opened = host.commands.get('boost').handler({ rawInput: `${repo} owned by another session`, agent: owner });
    assert.equal(opened.kind, 'success', opened.text);

    // A different session in the same parent folder: the run is discoverable
    // (useful context) but must NOT be destructively actionable, or a bare
    // /boost-deliver in a fresh session could merge someone else's work.
    const stranger = uniqueAgent(parent);
    const deliver = host.commands.get('boost-deliver').handler({ rawInput: '', agent: stranger });
    assert.equal(deliver.kind, 'error', 'deliver by inference must be refused');
    assert.match(deliver.text, /refusing to deliver by inference/i);

    const discard = host.commands.get('boost-discard').handler({ rawInput: '', agent: stranger });
    assert.equal(discard.kind, 'error', 'discard by inference must be refused');
    assert.match(discard.text, /refusing to discard by inference/i);

    // The owner can still deliver once verification passes.
    host.commands.get('boost-verify').handler({ rawInput: '', agent: owner });
    const ownerDeliver = host.commands.get('boost-deliver').handler({ rawInput: '', agent: owner });
    assert.equal(ownerDeliver.kind, 'success', ownerDeliver.text);
  });

  it('the owner can still deliver a run opened with an explicit repo path', async () => {
    const mod = await loadPlugin();
    const { ctx, host } = makeHost();
    const { parent, repo } = parentDirWithRepo();
    const owner = uniqueAgent(parent);
    mod.apply(ctx, { verifyCommands: ['node -e ""'] });
    host.commands.get('boost').handler({ rawInput: `${repo} a verified change`, agent: owner });
    host.commands.get('boost-verify').handler({ rawInput: '', agent: owner });
    const delivered = host.commands.get('boost-deliver').handler({ rawInput: '', agent: owner });
    assert.equal(delivered.kind, 'success', delivered.text);
  });
});

describe('plugin: tool behaviour', () => {
  it('boost_report rejects an investigation stream that claims file changes', async () => {
    const mod = await loadPlugin();
    const { ctx, host } = makeHost();
    const dir = makeRepo();
    mod.apply(ctx, { verifyCommands: ['node -e ""'] });
    host.tools.get('boost_run').execute({ task: 'investigate' }, { agent: agentFor(dir) });
    const out = await host.tools.get('boost_report').execute({ kind: 'investigation', summary: 'found it', files: ['app.js'] }, { agent: agentFor(dir) });
    assert.match(out.output, /must not modify files/i);
  });

  it('boost_run then boost_status round-trips', async () => {
    const mod = await loadPlugin();
    const { ctx, host } = makeHost();
    const dir = makeRepo();
    mod.apply(ctx, { verifyCommands: ['node -e ""'] });
    const run = await host.tools.get('boost_run').execute({ task: 'add a zero check' }, { agent: agentFor(dir) });
    assert.match(run.output, /opened/);
    const status = await host.tools.get('boost_status').execute({}, { agent: agentFor(dir) });
    assert.match(status.output, /phase:/);
  });

  it('boost_verify reports success after a passing round', async () => {
    const mod = await loadPlugin();
    const { ctx, host } = makeHost();
    const dir = makeRepo();
    mod.apply(ctx, { verifyCommands: ['node -e ""'] });
    await host.tools.get('boost_run').execute({ task: 'safe' }, { agent: agentFor(dir) });
    const out = await host.tools.get('boost_verify').execute({}, { agent: agentFor(dir) });
    assert.match(out.output, /passed/i);
  });
});
