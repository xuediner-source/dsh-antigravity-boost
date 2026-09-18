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
import { homedir } from 'node:os';
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

function ensureGitExclude(workspace) {
  try {
    const root = repoRoot(workspace);
    const gitDir = git(root, ['rev-parse', '--git-dir']);
    const absGitDir = join(root, gitDir);
    const excludeFile = join(absGitDir, 'info', 'exclude');
    if (existsSync(excludeFile)) {
      const content = readFileSync(excludeFile, 'utf8');
      if (!content.includes('.dsh-boost')) {
        writeFileSync(excludeFile, `${content.trimEnd()}\n.dsh-boost\n`, 'utf8');
      }
    } else {
      mkdirSync(join(absGitDir, 'info'), { recursive: true });
      writeFileSync(excludeFile, '.dsh-boost\n', 'utf8');
    }
  } catch {
    // Non-fatal if info/exclude is inaccessible
  }
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
    // The session cwd is often a parent folder of many projects (e.g.
    // F:\DPH). Say so, and list the repos that ARE usable instead of a bare
    // refusal.
    const nearby = nearbyRepos(workspace);
    const lines = [`${workspace} is not a git repository — /boost needs a repo to isolate worktrees.`];
    if (nearby.length > 0) {
      lines.push('', 'Git repositories available here:');
      for (const repo of nearby) {
        lines.push(`  ${repo}${repoHasRuns(repo) ? '  (has boost runs)' : ''}`);
      }
      lines.push('', 'Point /boost at one of them:  /boost <repo-path> <task>');
    } else {
      lines.push('', 'No git repositories found in this directory or its subdirectories.');
      lines.push('Point /boost at a repository explicitly:  /boost <repo-path> <task>');
    }
    return { ok: false, reason: lines.join('\n') };
  }
  const base = ref && ref.trim() ? ref.trim() : currentRef(workspace);
  if (!base) return { ok: false, reason: 'could not resolve the base ref' };

  ensureGitExclude(workspace);
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

/** Check if the worktree on disk has any uncommitted or untracked file changes. */
export function worktreeHasChanges(workspace, runId) {
  const state = readState(workspace, runId);
  if (!state) return { hasChanges: false, files: [] };
  try {
    const status = git(state.worktree, ['status', '--porcelain']);
    if (!status.trim()) return { hasChanges: false, files: [] };
    const files = status.split('\n').filter(Boolean).map((line) => line.slice(3).trim());
    return { hasChanges: true, files };
  } catch {
    return { hasChanges: false, files: [] };
  }
}

/** Auto-commit uncommitted changes in the ephemeral worktree to keep the boost branch current. */
export function autoCommitWorktree(workspace, runId, message = 'auto-commit') {
  const state = readState(workspace, runId);
  if (!state) return { ok: false, reason: `unknown run ${runId}` };
  try {
    const status = git(state.worktree, ['status', '--porcelain']);
    if (!status.trim()) {
      return { ok: true, committed: false, state };
    }
    git(state.worktree, ['add', '-A']);
    git(state.worktree, ['commit', '-q', '-m', `boost(${runId}): ${message}`]);
    state.updatedAt = Date.now();
    writeState(workspace, state);
    return { ok: true, committed: true, state };
  } catch (error) {
    return { ok: false, reason: `auto-commit failed: ${error instanceof Error ? error.message : String(error)}` };
  }
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

/** Diff summary of the worktree against its base, including uncommitted/untracked files. */
export function worktreeDiff(workspace, runId) {
  const state = readState(workspace, runId);
  if (!state) return { ok: false, reason: `unknown run ${runId}` };
  try {
    const stat = git(state.worktree, ['diff', '--stat', state.base]);
    const names = git(state.worktree, ['diff', '--name-only', state.base]);
    const untracked = git(state.worktree, ['status', '--porcelain']);
    const untrackedFiles = untracked
      ? untracked.split('\n').filter(Boolean).map((l) => l.slice(3).trim())
      : [];
    const diffFiles = names ? names.split('\n').filter(Boolean) : [];
    const allFiles = Array.from(new Set([...diffFiles, ...untrackedFiles]));
    return { ok: true, stat, files: allFiles };
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

  // Safety: auto-commit any pending changes in the worktree so they are not wiped on removal!
  autoCommitWorktree(workspace, runId, 'verified changes');

  const targetBranch = target || state.base;
  try {
    git(workspace, ['merge', '--no-ff', '-q', state.branch, '-m', `boost(${runId}): ${state.task.slice(0, 60) || 'verified change'}`]);
  } catch (error) {
    try { git(workspace, ['merge', '--abort']); } catch { /* ignore if already clean */ }
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

// ---------------------------------------------------------------------------
// Active-run pointers
//
// A session is often started in a parent folder that is not itself a repo
// (e.g. F:\DPH), while `/boost <repo-path> <task>` creates the run INSIDE the
// target repo. Without a pointer, follow-up commands (/boost-verify,
// /boost-status, ...) would look for the run under the session cwd, find
// nothing, and make /boost unusable from a parent folder. This registry
// records which run each session is currently driving.
// ---------------------------------------------------------------------------

/** Cross-repo bookkeeping root, analogous to the harness home. */
export function stateHome() {
  const base = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(base, 'dsh-boost');
}

function activeRegistryPath() {
  return join(stateHome(), 'active.json');
}

export function readActiveRegistry() {
  try {
    const parsed = JSON.parse(readFileSync(activeRegistryPath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Remember that `sessionId` is driving `runId` inside `workspace`. */
export function rememberActiveRun(sessionId, workspace, runId) {
  if (!sessionId || !workspace || !runId) return;
  const all = readActiveRegistry();
  all[String(sessionId)] = { workspace, runId, at: Date.now() };
  // Keep the file bounded: newest 50 sessions only.
  const kept = Object.entries(all)
    .sort((a, b) => (Number(b[1]?.at) || 0) - (Number(a[1]?.at) || 0))
    .slice(0, 50);
  try {
    mkdirSync(stateHome(), { recursive: true });
    writeFileSync(activeRegistryPath(), JSON.stringify(Object.fromEntries(kept), null, 2), 'utf8');
  } catch {
    // A registry write failure must never break a boost run.
  }
}

/** Drop the pointer once a run is delivered or discarded. */
export function forgetActiveRun(sessionId) {
  if (!sessionId) return;
  const all = readActiveRegistry();
  if (!(String(sessionId) in all)) return;
  delete all[String(sessionId)];
  try {
    mkdirSync(stateHome(), { recursive: true });
    writeFileSync(activeRegistryPath(), JSON.stringify(all, null, 2), 'utf8');
  } catch {
    // non-fatal
  }
}

/**
 * The run this session is currently driving, when it still exists on disk.
 * Returns null for an unknown session or a run already cleaned up.
 */
export function activeRunFor(sessionId) {
  if (!sessionId) return null;
  const rec = readActiveRegistry()[String(sessionId)];
  if (!rec || typeof rec.workspace !== 'string' || typeof rec.runId !== 'string') return null;
  const state = readState(rec.workspace, rec.runId);
  return state ? { workspace: rec.workspace, state } : null;
}

/** True when a directory has at least one recorded boost run. */
export function repoHasRuns(dir) {
  return listRuns(dir).length > 0;
}

/**
 * Git repositories reachable from `dir`: the directory itself plus its
 * immediate subdirectories. Used to turn "not a git repository" into an
 * actionable message — the session cwd is often a parent folder holding many
 * projects, and /boost just needs to be pointed at one of them.
 */
export function nearbyRepos(dir, limit = 8) {
  const out = [];
  const consider = (d) => {
    if (out.includes(d)) return;
    try { if (isGitRepo(d)) out.push(d); } catch { /* skip */ }
  };
  consider(dir);
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= limit) break;
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      consider(join(dir, entry.name));
    }
  } catch { /* unreadable directory — nothing nearby to offer */ }
  return out.slice(0, limit);
}
