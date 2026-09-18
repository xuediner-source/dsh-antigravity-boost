import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlugin, makeHost } from './harness.mjs';

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

const agentFor = (dir) => ({ session: { id: 'sess-1', header: { cwd: dir } } });

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
    for (const t of TOOLS) assert.ok(host.tools.has(t), `tool ${t} must be registered`);
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
