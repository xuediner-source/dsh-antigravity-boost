/**
 * Boost orchestration pipeline — the official three-phase model
 * (antigravity.google/docs/boost/):
 *
 *   Phase 1  Goal & strategy formulation
 *            The orchestrator breaks the task into discrete, verifiable
 *            subtasks and decides which specialized workstreams are needed.
 *
 *   Phase 2  Parallel execution & verification
 *            Implementation workstreams construct code; investigation
 *            workstreams trace root causes and MUST NOT modify files.
 *            Every workstream validates locally before reporting.
 *
 *   Phase 3  Synthesis & delivery
 *            The orchestrator validates the combined solution against the full
 *            test suite. If an assertion fails, diagnostics are fed back into
 *            the next iteration for automated correction. Only once everything
 *            passes is a verified change delivered.
 *
 * This module owns the state machine and the iteration loop; `worktree.js`
 * owns the ephemeral workspace, `verify.js` owns command execution.
 */
import { recordVerification, recordWorkstream, readState, writeState, worktreeHasChanges } from './worktree.js';
import { runRound } from './verify.js';

export const PIPELINE_DEFAULTS = {
  maxRounds: 3,
  /** Official Boost splits work into implementation + investigation streams. */
  workstreamKinds: ['implementation', 'investigation'],
};

/** Phase 1 — decompose the task into workstreams. */
export function plan(task, { maxRounds = PIPELINE_DEFAULTS.maxRounds } = {}) {
  if (!task || !task.trim()) {
    return { ok: false, reason: 'a /boost run needs a task statement' };
  }
  return {
    ok: true,
    task: task.trim(),
    maxRounds,
    // Official streams: implementation constructs code, investigation traces
    // root causes without modifying files.
    workstreams: PIPELINE_DEFAULTS.workstreamKinds.map((kind) => ({ kind, status: 'pending' })),
  };
}

/**
 * Investigation reports are read-only by contract: "Investigation workstreams:
 * Perform root-cause debugging, trace execution call graphs, and analyze
 * unfamiliar dependencies **without modifying files**."
 *
 * If an investigation workstream reports changed files or modifies files on disk,
 * the report is rejected — that is implementation work wearing the wrong label.
 */
export function validateWorkstream(state, { kind, files = [] }, context = {}) {
  if (kind === 'investigation') {
    if (files.length > 0) {
      return {
        ok: false,
        reason: `investigation workstreams must not modify files (reported: ${files.join(', ')}) — move the change to an implementation workstream`,
      };
    }
    const workspace = context.workspace;
    const runId = context.runId || state?.runId;
    if (workspace && runId) {
      const disk = worktreeHasChanges(workspace, runId);
      if (disk.hasChanges) {
        return {
          ok: false,
          reason: `investigation workstreams must not modify files on disk (detected: ${disk.files.join(', ')}) — move changes to an implementation workstream or revert worktree edits`,
        };
      }
    }
  }
  if (!PIPELINE_DEFAULTS.workstreamKinds.includes(kind)) {
    return { ok: false, reason: `unknown workstream kind "${kind}"` };
  }
  return { ok: true };
}

/**
 * Phase 2 + 3 — run one verification round against the worktree, feeding
 * diagnostics back on failure.
 *
 * Returns the run outcome:
 *   status 'delivered'      all rounds passed
 *   status 'iterating'      a round failed and maxRounds is not yet reached
 *   status 'needs_review'   rounds exhausted; diagnostics handed to the user
 */
export function iterate(workspace, runId, { verifyCommands, options } = {}) {
  const state = readState(workspace, runId);
  if (!state) return { ok: false, reason: `unknown run ${runId}` };

  const commands = verifyCommands && verifyCommands.length ? verifyCommands : state.verifyCommands;
  if (!commands || !commands.length) {
    return { ok: false, reason: 'no verify commands configured — set verifyCommands in config or on the run' };
  }

  const maxRounds = state.maxRounds ?? PIPELINE_DEFAULTS.maxRounds;
  const result = runRound(commands, { cwd: state.worktree, ...options });
  recordVerification(workspace, runId, {
    passed: result.passed,
    failedCommand: result.failedCommand,
    diagnostics: result.diagnostics,
  });
  const after = readState(workspace, runId);

  if (result.passed) {
    after.phase = 'verified';
    after.updatedAt = Date.now();
    writeState(workspace, after);
    return { ok: true, status: 'delivered', round: after.round, state: after };
  }

  // Official Phase 3: "If an assertion fails, error diagnostics are fed back
  // into the next iteration for automated correction."
  const exhausted = after.round >= maxRounds;
  after.phase = exhausted ? 'needs_review' : 'iterating';
  after.lastDiagnostics = result.diagnostics;
  after.updatedAt = Date.now();
  writeState(workspace, after);

  return {
    ok: true,
    status: exhausted ? 'needs_review' : 'iterating',
    round: after.round,
    maxRounds,
    failedCommand: result.failedCommand,
    diagnostics: result.diagnostics,
    feedback: exhausted
      ? `Verification failed ${after.round}/${maxRounds} rounds. Diagnostics for human review:\n${result.diagnostics}`
      : `Verification failed (round ${after.round}/${maxRounds}). Fix the issue in the worktree, then run boost again — diagnostics:\n${result.diagnostics}`,
    state: after,
  };
}

/** Record a workstream report after enforcing the investigation contract. */
export function report(workspace, runId, reportEntry) {
  const state = readState(workspace, runId);
  if (!state) return { ok: false, reason: `unknown run ${runId}` };
  const check = validateWorkstream(state, reportEntry, { workspace, runId });
  if (!check.ok) return check;
  return recordWorkstream(workspace, runId, reportEntry);
}

/** Human-readable run summary for /boost-status. */
export function summarize(state) {
  if (!state) return 'no boost run';
  return [
    `run:       ${state.runId}`,
    `phase:     ${state.phase}`,
    `task:      ${state.task || '(none)'}`,
    `branch:    ${state.branch}`,
    `worktree:  ${state.worktree}`,
    `round:     ${state.round}${state.maxRounds ? ` / ${state.maxRounds}` : ''}`,
    `streams:   ${state.workstreams.length ? state.workstreams.map((w) => `${w.kind}: ${w.summary ?? ''}`).join(' | ') : '(none reported)'}`,
    `verified:  ${state.verifications.filter((v) => v.passed).length}/${state.verifications.length} rounds passed`,
  ].join('\n');
}
