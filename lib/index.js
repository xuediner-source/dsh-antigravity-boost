/**
 * dsh-antigravity-boost — Antigravity /boost-style deep reasoning for DSH.
 *
 * Surface, mirroring the official Antigravity client
 * (antigravity.google/docs/boost/):
 *
 *   /boost     start a deep-reasoning run in an ephemeral isolated worktree
 *   /boost-status   show the current run
 *   /boost-verify   run one verification round (failure -> diagnostics feedback)
 *   /boost-report   record an implementation / investigation workstream
 *   /boost-deliver  merge verified changes and remove the ephemeral worktree
 *   /boost-discard  abort the run and remove the worktree
 *
 *   boost_run / boost_status / boost_verify / boost_report / boost_deliver
 *
 * Workspace targeting: a session is often started in a parent folder holding
 * many projects (e.g. F:\DPH), which is not itself a git repository. Every
 * command therefore accepts an optional leading `<repo-path>` token, and run
 * lookups fall back to nearby repositories that already hold boost runs.
 *
 * Prompt injection: a system-prompt usage section carries the three-phase
 * protocol, including the official rule that investigation workstreams must
 * NOT modify files — that separation is what makes /boost different from
 * "just run the tests".
 */
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { isGitRepo, closeRun, createRun, listRuns, nearbyRepos, readState, removeWorktree } from './worktree.js';
import { iterate, plan, report, summarize } from './pipeline.js';

export const name = 'dsh-antigravity-boost';
export const inject = ['commands', 'agents', 'tools', 'systemPrompt'];

export const Config = z.object({
  enabled: z.boolean().default(true),
  promptSectionOrder: z.number().default(129),
  verifyCommands: z.array(z.string()).default([]),
  maxRounds: z.number().min(1).default(3),
  keepWorktreeOnFailure: z.boolean().default(true),
  timeoutMs: z.number().default(300_000),
});

const ok = (text) => ({ kind: 'success', text });
const err = (text) => ({ kind: 'error', text });

const workspaceOf = (agent) => agent?.session?.header?.cwd ?? process.cwd();

/** DSH `defineTool` reads `options.output.render` unguarded; missing output
 *  crashes the whole plugin tree (`Cannot read properties of undefined
 *  (reading 'render')`). Parameters are an implicit property map, not JSON
 *  Schema (`required: true` lives on each field). */
const textOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      output: { type: 'string', required: true },
    },
  },
  render: (_args, value) => [{ type: 'text', text: String(value?.output ?? '') }],
};

const USAGE_SECTION = `Boost deep reasoning (/boost) — Antigravity-style three-phase pipeline:

Phase 1  Goal & strategy formulation: decompose the task into discrete,
         verifiable subtasks and decide which workstreams are needed.
Phase 2  Parallel execution & verification: implementation workstreams
         construct code; investigation workstreams trace root causes and MUST
         NOT modify files. Verify locally before reporting.
Phase 3  Synthesis & delivery: validate the combined solution against the full
         test suite. On failure, feed the diagnostics into another iteration.
         Deliver only after every verification round passes.

Workflow:
1. /boost [repo-path] <task> — opens an ephemeral isolated worktree for the
   run. The repo-path token is optional; /boost needs a git repository, so
   when the session cwd is a parent folder, pass the project path explicitly
   (e.g. /boost F:/DPH/dsh-subs-hub fix the race in the cache).
2. Work streams: call boost_report with kind=implementation (code changes) or
   kind=investigation (root-cause findings, files MUST be empty and unedited).
3. /boost-verify [repo-path] — runs the configured verify commands inside the
   worktree. On failure it returns diagnostics for the next iteration; on
   success the run becomes verified.
4. /boost-deliver — merges the boost branch and removes the ephemeral worktree.
   /boost-discard aborts without merging.

Instructions in the current conversation take precedence over this protocol.`;

export function apply(ctx, config) {
  if (config.enabled === false) {
    ctx.logger?.info?.(`${name}: disabled by config`);
    return;
  }

  const opts = {
    maxRounds: config.maxRounds ?? 3,
    verifyCommands: config.verifyCommands ?? [],
    keepWorktreeOnFailure: config.keepWorktreeOnFailure !== false,
    promptSectionOrder: config.promptSectionOrder ?? 129,
    timeoutMs: config.timeoutMs ?? 300_000,
  };

  ctx.systemPrompt.section({
    name: 'boost:usage',
    order: opts.promptSectionOrder,
    text: USAGE_SECTION,
  });

  const guard = (fn) => (invocation) => {
    try {
      return fn(invocation);
    } catch (error) {
      return err(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const commands = [
    {
      name: 'boost',
      description: 'start a /boost deep-reasoning run in an ephemeral isolated worktree',
      input: { hint: '[repo-path] <task — what to investigate or implement>' },
      handler: guard((invocation) => {
        const target = resolveTarget(invocation.rawInput, workspaceOf(invocation.agent));
        const task = target.rest;
        const planned = plan(task, { maxRounds: opts.maxRounds });
        if (!planned.ok) return err(`${name}: ${planned.reason}`);
        const created = createRun(target.workspace, {
          task,
          verifyCommands: opts.verifyCommands,
          mode: 'implementation',
        });
        if (!created.ok) return err(`${name}: ${created.reason}`);
        const s = created.state;
        s.maxRounds = opts.maxRounds;
        return ok([
          `${name}: run ${s.runId} opened`,
          `repo:     ${target.workspace}${target.explicit ? '' : target.inferred ? '  (inferred)' : '  (session cwd)'}`,
          `worktree: ${s.worktree}`,
          `branch:   ${s.branch}`,
          `base:     ${s.base}`,
          `verify:   ${s.verifyCommands.length ? s.verifyCommands.join(' && ') : '(none configured)'}`,
          '',
          'Three-phase protocol:',
          '  1. Plan — decompose into implementation + investigation workstreams',
          '  2. Execute & verify — work inside the worktree; investigation streams must not modify files',
          '  3. Synthesize — /boost-verify runs the suite; on failure, iterate with the diagnostics',
          '',
          'Next: boost_report (record workstreams) then /boost-verify.',
        ].join('\n'));
      }),
    },
    {
      name: 'boost-status',
      description: 'show the current boost run',
      input: { hint: '[repo-path | runId — optional]' },
      handler: guard((invocation) => {
        const found = locateRun(invocation.rawInput, workspaceOf(invocation.agent));
        if (!found.state) return ok(`${name}: no boost run found\n${found.hint}`);
        return ok(`repo: ${found.workspace}\n${summarize(found.state)}`);
      }),
    },
    {
      name: 'boost-verify',
      description: 'run one verification round; failures return diagnostics for the next iteration',
      input: { hint: '[repo-path | runId — optional]' },
      handler: guard((invocation) => {
        const found = locateRun(invocation.rawInput, workspaceOf(invocation.agent));
        if (!found.state) return err(`${name}: no boost run — start one with /boost [repo-path] <task>\n${found.hint}`);
        const outcome = iterate(found.workspace, found.state.runId, {
          verifyCommands: opts.verifyCommands,
          options: { timeoutMs: opts.timeoutMs },
        });
        if (!outcome.ok) return err(`${name}: ${outcome.reason}`);
        if (outcome.status === 'delivered') {
          return ok(`${name}: verification passed on round ${outcome.round}. Deliver with /boost-deliver.`);
        }
        return ok(`${name}: ${outcome.feedback}`);
      }),
    },
    {
      name: 'boost-report',
      description: 'record an implementation or investigation workstream',
      input: { hint: '<kind> <summary>  |  [repo-path] kind=investigation files= summary=...' },
      handler: guard((invocation) => {
        const found = locateRun(invocation.rawInput, workspaceOf(invocation.agent), { keepReportText: true });
        if (!found.state) return err(`${name}: no boost run — start one with /boost [repo-path] <task>\n${found.hint}`);
        const entry = parseReport(found.rest);
        const result = report(found.workspace, found.state.runId, entry);
        if (!result.ok) return err(`${name}: ${result.reason}`);
        return ok(`${name}: recorded ${entry.kind} workstream for ${found.state.runId} (repo ${found.workspace})`);
      }),
    },
    {
      name: 'boost-deliver',
      description: 'merge the verified boost branch and remove the ephemeral worktree',
      input: { hint: '[repo-path | runId — optional]' },
      handler: guard((invocation) => {
        const found = locateRun(invocation.rawInput, workspaceOf(invocation.agent));
        if (!found.state) return err(`${name}: no boost run\n${found.hint}`);
        const verified = found.state.verifications.length > 0 && found.state.verifications.every((v) => v.passed);
        if (!verified) {
          return err(`${name}: run ${found.state.runId} has not passed every verification round — run /boost-verify first`);
        }
        const closed = closeRun(found.workspace, found.state.runId, { keepWorktree: false });
        if (!closed.ok) return err(`${name}: ${closed.reason}`);
        return ok(`${name}: verified changes merged to ${closed.target}; ephemeral worktree removed`);
      }),
    },
    {
      name: 'boost-discard',
      description: 'abort the boost run and remove the ephemeral worktree',
      input: { hint: '[repo-path | runId — optional]' },
      handler: guard((invocation) => {
        const found = locateRun(invocation.rawInput, workspaceOf(invocation.agent));
        if (!found.state) return err(`${name}: no boost run\n${found.hint}`);
        const removed = removeWorktree(found.workspace, found.state.runId);
        if (!removed.ok) return err(`${name}: ${removed.reason}`);
        return ok(`${name}: run ${found.state.runId} discarded; worktree removed`);
      }),
    },
  ];

  for (const def of commands) {
    ctx.effect(() => ctx.commands.register(def), `${name}: /${def.name}`);
  }

  // ----------------------------------------------------------------- tools
  const cwdOf = (exec) => exec?.agent?.session?.header?.cwd ?? process.cwd();

  const tools = [
    defineTool({
      name: 'boost_run',
      description: 'Open an ephemeral isolated worktree for a /boost deep-reasoning run. Pass workspace to target a specific git repository when the session directory is not one.',
      parameters: {
        task: { type: 'string', required: true, description: 'The task to investigate or implement' },
        workspace: { type: 'string', description: 'Path to the git repository to isolate; defaults to the session cwd' },
      },
      output: textOutput,
      async execute(args, exec) {
        const planned = plan(args.task, { maxRounds: opts.maxRounds });
        if (!planned.ok) return { output: planned.reason };
        const base = args.workspace ? resolve(args.workspace) : cwdOf(exec);
        const created = createRun(base, { task: args.task, verifyCommands: opts.verifyCommands });
        if (!created.ok) return { output: created.reason };
        return { output: `run ${created.state.runId} opened\nrepo: ${base}\nworktree: ${created.state.worktree}\nbranch: ${created.state.branch}` };
      },
    }),
    defineTool({
      name: 'boost_status',
      description: 'Show the current boost run state.',
      parameters: {
        runId: { type: 'string', description: 'Boost run id; defaults to the latest run' },
        workspace: { type: 'string', description: 'Path to the git repository holding the run; defaults to the session cwd' },
      },
      output: textOutput,
      async execute(args, exec) {
        const base = args.workspace ? resolve(args.workspace) : cwdOf(exec);
        const found = locateRun(args.runId ?? '', base);
        return { output: found.state ? `repo: ${found.workspace}\n${summarize(found.state)}` : 'no boost run' };
      },
    }),
    defineTool({
      name: 'boost_verify',
      description: 'Run one verification round inside the boost worktree; failures return diagnostics for the next iteration.',
      parameters: {
        runId: { type: 'string', description: 'Boost run id; defaults to the latest run' },
        workspace: { type: 'string', description: 'Path to the git repository holding the run; defaults to the session cwd' },
      },
      output: textOutput,
      async execute(args, exec) {
        const base = args.workspace ? resolve(args.workspace) : cwdOf(exec);
        const found = locateRun(args.runId ?? '', base);
        if (!found.state) return { output: 'no boost run — start one with boost_run' };
        const outcome = iterate(found.workspace, found.state.runId, {
          verifyCommands: opts.verifyCommands,
          options: { timeoutMs: opts.timeoutMs },
        });
        if (!outcome.ok) return { output: outcome.reason };
        if (outcome.status === 'delivered') return { output: `verification passed on round ${outcome.round}` };
        return { output: outcome.feedback };
      },
    }),
    defineTool({
      name: 'boost_report',
      description: 'Record an implementation or investigation workstream. Investigation streams must not report file changes.',
      parameters: {
        kind: { type: 'string', required: true, description: 'implementation or investigation' },
        summary: { type: 'string', required: true, description: 'What the workstream found or built' },
        files: { type: 'array', items: { type: 'string' }, description: 'Files changed (implementation only)' },
        workspace: { type: 'string', description: 'Path to the git repository holding the run; defaults to the session cwd' },
      },
      output: textOutput,
      async execute(args, exec) {
        const base = args.workspace ? resolve(args.workspace) : cwdOf(exec);
        const found = locateRun('', base);
        if (!found.state) return { output: 'no boost run' };
        const result = report(found.workspace, found.state.runId, { kind: args.kind, summary: args.summary, files: args.files ?? [] });
        return { output: result.ok ? `recorded ${args.kind} workstream` : result.reason };
      },
    }),
    defineTool({
      name: 'boost_deliver',
      description: 'Merge the verified boost branch and remove the ephemeral worktree.',
      parameters: {
        runId: { type: 'string', description: 'Boost run id; defaults to the latest run' },
        workspace: { type: 'string', description: 'Path to the git repository holding the run; defaults to the session cwd' },
      },
      output: textOutput,
      async execute(args, exec) {
        const base = args.workspace ? resolve(args.workspace) : cwdOf(exec);
        const found = locateRun(args.runId ?? '', base);
        if (!found.state) return { output: 'no boost run' };
        const verified = found.state.verifications.length > 0 && found.state.verifications.every((v) => v.passed);
        if (!verified) return { output: 'run has not passed every verification round — run boost_verify first' };
        const closed = closeRun(found.workspace, found.state.runId, { keepWorktree: false });
        return { output: closed.ok ? `merged to ${closed.target}; worktree removed` : closed.reason };
      },
    }),
  ];

  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `${name}: ${tool.name}`);
  }

  ctx.logger?.info?.(`${name}: boost deep-reasoning enabled (maxRounds=${opts.maxRounds})`);
}

// ---------------------------------------------------------------------------
// Workspace targeting
// ---------------------------------------------------------------------------

/**
 * Resolve which repository a command targets.
 *
 * A leading token is treated as a repo path when it looks like a path AND
 * resolves to an existing git repository. Otherwise the session cwd is used
 * when it is a repo; failing that, a single nearby repo that already holds
 * boost runs is inferred. Otherwise the session cwd is returned unchanged so
 * the caller's error path can list what is available.
 */
export function resolveTarget(rawInput, sessionWorkspace) {
  const text = String(rawInput ?? '').trim();
  const first = text.split(/\s+/)[0] ?? '';
  const looksLikePath = first.length > 0 && (/[\\/]/.test(first) || /^[A-Za-z]:/.test(first));
  if (looksLikePath) {
    try {
      const abs = resolve(first);
      if (existsSync(abs) && isGitRepo(abs)) {
        return { workspace: abs, rest: text.slice(first.length).trim(), explicit: true };
      }
    } catch { /* fall through to the session-cwd resolution */ }
  }
  if (isGitRepo(sessionWorkspace)) {
    return { workspace: sessionWorkspace, rest: text, explicit: false };
  }
  const nearby = nearbyRepos(sessionWorkspace);
  const withRuns = nearby.filter((r) => listRuns(r).length > 0);
  if (withRuns.length === 1) {
    return { workspace: withRuns[0], rest: text, explicit: false, inferred: true };
  }
  return { workspace: sessionWorkspace, rest: text, explicit: false };
}

/** Most recently created run in this workspace. */
export function latestRun(workspace) {
  const ids = listRuns(workspace);
  if (!ids.length) return null;
  return ids.sort().pop();
}

/**
 * Locate the run a command should act on.
 *
 * Resolution order: explicit repo path, run id in that repo, run id in nearby
 * repos, latest run in that repo, then the latest run in any nearby repo that
 * has one. When nothing is found the returned `hint` lists the repositories
 * that do hold runs — or the git repos that exist nearby — so the next command
 * can be pointed at the right place.
 */
export function locateRun(rawInput, sessionWorkspace, { keepReportText = false } = {}) {
  const target = resolveTarget(rawInput, sessionWorkspace);
  const token = target.rest.split(/\s+/)[0] ?? '';
  const restText = target.rest;

  const candidates = [target.workspace, ...nearbyRepos(target.workspace).filter((r) => r !== target.workspace)];

  // 1. explicit run id
  if (token) {
    for (const repo of candidates) {
      const state = readState(repo, token);
      if (state) {
        return { workspace: repo, state, rest: restText.slice(token.length).trim(), hint: '' };
      }
    }
  }

  // 2. latest run in the target repo, else in nearby repos
  for (const repo of candidates) {
    const id = latestRun(repo);
    if (!id) continue;
    const state = readState(repo, id);
    if (state) {
      return { workspace: repo, state, rest: keepReportText ? restText : '', hint: '' };
    }
  }

  // 3. nothing found — say where runs do exist, or what repos exist nearby
  const withRuns = nearbyRepos(target.workspace).filter((r) => listRuns(r).length > 0);
  const repos = nearbyRepos(target.workspace);
  let hint;
  if (withRuns.length > 0) {
    hint = `Boost runs exist in:\n${withRuns.map((r) => `  ${r}`).join('\n')}\nPoint the command at one: /boost-verify <repo-path>`;
  } else if (repos.length > 0) {
    hint = `Git repositories available here:\n${repos.map((r) => `  ${r}`).join('\n')}\nStart a run first: /boost <repo-path> <task>`;
  } else {
    hint = 'No git repositories found nearby.';
  }
  return { workspace: target.workspace, state: null, rest: keepReportText ? restText : '', hint };
}

/** Parse `kind summary...` or `kind=investigation files=a,b summary=...`. */
export function parseReport(raw) {
  const text = String(raw ?? '').trim();
  const kindMatch = text.match(/^(implementation|investigation)\b/i);
  const kind = kindMatch ? kindMatch[1].toLowerCase() : 'implementation';
  const filesMatch = text.match(/files=([^\s]+)/i);
  const files = filesMatch ? filesMatch[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
  const summary = text
    .replace(/^(implementation|investigation)\b/i, '')
    .replace(/files=[^\s]+/gi, '')
    .replace(/^kind=(implementation|investigation)\b/i, '')
    .trim();
  return { kind, summary: summary || '(no summary)', files };
}
