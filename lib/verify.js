/**
 * Local verification — the official Boost Phase 2/3 behaviour
 * (antigravity.google/docs/boost/):
 *
 *   Phase 2 — "Local verification: Subagents execute build targets and test
 *   suites locally to validate hypotheses before reporting results."
 *
 *   Phase 3 — "The Orchestrator validates the combined solution against full
 *   test suites and edge cases. If an assertion fails, error diagnostics are
 *   fed back into the next iteration for automated correction. Once all tests
 *   and requirements pass, a concise summary with verified changes is
 *   delivered."
 *
 * This module runs the commands and returns structured diagnostics; it never
 * merges anything. The pipeline decides whether the diagnostics are fed back
 * into another iteration or the run is delivered.
 */
import { spawnSync } from 'node:child_process';

/** Official default: run each verify command with a bounded timeout. */
export const VERIFY_DEFAULTS = {
  timeoutMs: 300_000,
  maxOutputChars: 12_000,
};

/** Trim a long command tail to a bounded diagnostics excerpt. */
export function tail(text, max = VERIFY_DEFAULTS.maxOutputChars) {
  const s = String(text ?? '');
  return s.length <= max ? s : `…(truncated)\n${s.slice(-max)}`;
}

/**
 * Tokenize a command line, honouring quoted arguments.
 *
 * `spawnSync` runs with `shell: false`, so a naive whitespace split feeds the
 * surrounding quote characters into argv: `node -e "process.exit(1)"` would
 * evaluate the STRING LITERAL `"process.exit(1)"` — a no-op that exits 0, and
 * the verification gate would report a failing command as passing. That
 * silently defeats the whole point of /boost, so quotes must be stripped here.
 */
export function splitCommand(command) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(command))) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3]);
  }
  return tokens;
}

/**
 * Run one command in `cwd`. Returns a structured verdict — passed, exitCode,
 * durationMs, and `diagnostics` (stdout+stderr tail) suitable for feeding back
 * into the next iteration.
 */
export function runCommand(command, { cwd, timeoutMs = VERIFY_DEFAULTS.timeoutMs, env = {} } = {}) {
  const started = Date.now();
  const trimmed = String(command ?? '').trim();
  if (!trimmed) {
    return { command, passed: false, exitCode: null, timedOut: false, spawnError: 'empty command', durationMs: 0, diagnostics: 'empty command' };
  }

  // Cross-platform execution:
  // On Windows, npm/pnpm/yarn are .cmd/.bat batch scripts, which throw ENOENT if spawned
  // without a shell. shell: true also natively supports compound commands (&&, pipes, redirections).
  const isWindows = process.platform === 'win32';
  const result = spawnSync(trimmed, {
    cwd,
    timeout: timeoutMs,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    shell: isWindows ? (process.env.ComSpec || 'cmd.exe') : true,
  });

  const durationMs = Date.now() - started;
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const timedOut = result.error?.code === 'ETIMEDOUT' || /ETIMEDOUT/.test(String(result.error));
  const spawnError = result.error && !timedOut ? String(result.error.message ?? result.error) : null;

  const passed = !timedOut && !spawnError && result.status === 0;
  const diagnostics = passed ? '' : tail([stdout, stderr, spawnError, timedOut ? `timed out after ${timeoutMs}ms` : ''].filter(Boolean).join('\n'));

  return { command, passed, exitCode: result.status, timedOut, spawnError, durationMs, diagnostics };
}

/**
 * Run a whole verification round: every command must pass. `passed` is the
 * conjunction — matching "Once ALL tests and requirements pass".
 */
export function runRound(commands, options = {}) {
  const results = [];
  for (const command of commands) {
    const r = runCommand(command, options);
    results.push(r);
    if (!r.passed) {
      // Stop at the first failure: its diagnostics are what the next iteration
      // needs, and later commands may take minutes for no new information.
      return { passed: false, results, failedCommand: command, diagnostics: r.diagnostics };
    }
  }
  return { passed: true, results, failedCommand: null, diagnostics: '' };
}
