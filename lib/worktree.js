/**
 * Ephemeral isolated worktrees — the workspace model behind Antigravity /boost.
 *
 * From the official spec (antigravity.google/docs/boost/), the Boost row of the
 * comparison table:
 *
 *   Workspace model   Ephemeral isolated worktrees
 *   Task horizon      Seconds to hours
 *   Verification      Multi-round independent verification
 *
 * Contrast with the Teamwork row: "Persistent isolated worktrees per
 * milestone". /boost worktrees are throwaway — created for one hard task,
 * verified inside, merged or discarded, then removed.
 *
 * State lives under `<workspace>/.dsh-boost/runs/<runId>/` alongside the
 * worktree itself so a crash leaves an inspectable trail.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const RUNS_DIR = '.dsh-boost';
const RUNS_SUBDIR = 'runs';
const WORKTREES_SUBDIR = 'worktrees';

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** True when the directory is inside a git work tree. */
export function isGitRepo(dir) {
  try { return git(dir, ['rev-parse', '--is-inside-work-tree']) === 'true'; }
  catch { return false; }
}

/** Root of the git repository containing `dir`. */
export function repoRoot(dir) {
  try { return git(dir, ['rev-parse', '--show-toplevel']); }
  catch { return dir; }
}

/** Current branch, or the commit SHA when detached. */
export function currentRef(dir) {
  try { return git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']); }
  catch { return ''; }
}

export function pathsFor(workspace) {
  const root = repoRoot(workspace);
  const base = join(root, RUNS_DIR);
  return {
    repoRoot: root,
    runsRoot: join(base, RUNS_SUBDIR),
    worktreesRoot: join(base, WORKTREES_SUBDIR),
  };
}

function runDir(workspace, runId) {
  return join(pathsFor(workspace).runsRoot, runId);
}

function statePath(workspace, runId) {
  return join(runDir(workspace, runId), 'state.json');
}

export function readState(workspace, runId) {
  try { return JSON.parse(readFileSync(statePath(workspace, runId), 'utf8')); }
  catch { return null; }
}

export function writeState(workspace, state) {
  const dir = runDir(workspace, state.runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(statePath(workspace, state.runId), JSON.stringify(state, null, 2), 'utf8');
  return state;
}

/** Short deterministic run id: boost-<epoch36>-<rand4>. */
export function newRunId(now = Date.now()) {
  return `boost-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Create an ephemeral worktree for one Boost run.
 *
 * The branch is `boost/<runId>` based on `ref` (default: current HEAD). The
 * worktree path is `<repo>/.dsh-boost/worktrees/<runId>` — inside the repo's
 * boost state dir so cleanup is one rm -rf, never scattered across the disk.
 */
export function createRun(workspace, { runId = newRunId(), task = '', ref, verifyCommands = [], mode = 'implementation', now = Date.now() } = {}) {
  const paths = pathsFor(workspace);
  if (!isGitRepo(workspace)) {
    return { ok: false, reason: `${workspace} is not a git repository — /boost needs a repo to isolate worktrees` };
  }
  const base = ref && ref.trim() ? ref.trim() : currentRef(workspace);
  if (!base) return { ok: false, reason: 'could not resolve the base ref' };

  mkdirSync(paths.worktreesRoot, { recursive: true });
  mkdirSync(paths.runsRoot, { recursive: true });

  const branch = `boost/${runId}`;
  const worktree = join(paths.worktreesRoot, runId);
  if (existsSync(worktree)) {
    return { ok: false, reason: `worktree already exists at ${worktree}` };
  }
  try {
    git(workspace, ['worktree', 'add', '-q', '-b', branch, worktree, base]);
  } catch (error) {
    return { ok: false, reason: `git worktree add failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  const state = {
    runId,
    task,
    mode,
    branch,
    worktree,
    base,
    verifyCommands,
    phase: 'execution',
    round: 0,
    maxRounds: 3,
    workstreams: [],
    verifications: [],
    createdAt: now,
    updatedAt: now,
  };
  writeState(workspace, state);
  return { ok: true, state };
}

/** Record one workstream's outcome (implementation or investigation). */
export function recordWorkstream(workspace, runId, { kind, summary, files = [], findings = '' }) {
  const state = readState(workspace, runId);
  if (!state) return { ok: false, reason: `unknown run ${runId}` };
  state.workstreams.push({ kind, summary, files, findings, at: Date.now() });
  state.updatedAt = Date.now();
  writeState(workspace, state);
  return { ok: true, state };
}

/** Append one verification round's result. */
export function recordVerification(workspace, runId, result) {
  const state = readState(workspace, runId);
  if (!state) return { ok: false, reason: `unknown run ${runId}` };
  state.round += 1;
  state.verifications.push({ round: state.round, ...result });
  state.updatedAt = Date.now();
  writeState(workspace, state);
  return { ok: true, state };
}

/** Diff summary of the worktree against its base. */
export function worktreeDiff(workspace, runId) {
  const state = readState(workspace, runId);
  if (!state) return { ok: false, reason: `unknown run ${runId}` };
  try {
    const stat = git(state.worktree, ['diff', '--stat', state.base]);
    const names = git(state.worktree, ['diff', '--name-only', state.base]);
    return { ok: true, stat, files: names ? names.split('\n').filter(Boolean) : [] };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Deliver the run: merge the boost branch into the target branch when all
 * verification rounds passed, then remove the ephemeral worktree. On failure
 * the worktree is kept for inspection — the official Boost model reports the
 * diagnostics rather than merging an unverified change.
 */
export function closeRun(workspace, runId, { target, keepWorktree = false } = {}) {
  const state = readState(workspace, runId);
  if (!state) return { ok: false, reason: `unknown run ${runId}` };
  const passed = state.verifications.length > 0 && state.verifications.every((v) => v.passed);
  if (!passed) {
    return {
      ok: false,
      merged: false,
      reason: 'verification did not pass on every round — worktree kept for inspection',
      worktree: state.worktree,
      state,
    };
  }
  const targetBranch = target || state.base;
  try {
    git(workspace, ['merge', '--no-ff', '-q', state.branch, '-m', `boost(${runId}): ${state.task.slice(0, 60) || 'verified change'}`]);
  } catch (error) {
    return { ok: false, merged: false, reason: `merge failed: ${error instanceof Error ? error.message : String(error)}`, state };
  }
  if (!keepWorktree) removeWorktree(workspace, runId);
  state.phase = 'delivered';
  state.updatedAt = Date.now();
  writeState(workspace, state);
  return { ok: true, merged: true, target: targetBranch, state };
}

/** Remove the ephemeral worktree and its branch, keeping the run record. */
export function removeWorktree(workspace, runId) {
  const state = readState(workspace, runId);
  if (!state) return { ok: false, reason: `unknown run ${runId}` };
  try { git(workspace, ['worktree', 'remove', '--force', state.worktree]); }
  catch { rmSync(state.worktree, { recursive: true, force: true }); }
  try { git(workspace, ['branch', '-D', state.branch]); } catch { /* branch may be merged */ }
  state.phase = state.phase === 'delivered' ? 'delivered' : 'aborted';
  state.updatedAt = Date.now();
  writeState(workspace, state);
  return { ok: true, state };
}

/** List run records under a workspace. */
export function listRuns(workspace) {
  const paths = pathsFor(workspace);
  if (!existsSync(paths.runsRoot)) return [];
  return readdirSync(paths.runsRoot).filter((n) => n.startsWith('boost-'));
}
