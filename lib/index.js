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
 * Prompt injection: a system-prompt usage section carries the three-phase
 * protocol, including the official rule that investigation workstreams must
 * NOT modify files — that separation is what makes /boost different from
 * "just run the tests".
 */
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { closeRun, createRun, listRuns, readState, removeWorktree } from './worktree.js';
import { iterate, plan, report, summarize } from './pipeline.js';

export const name = 'dsh-antigravity-boost';
export const inject = ['commands', 'agents', 'tools', 'systemPrompt'];

export const Config = z.object({
  enabled: z.boolean().default(true),
  promptSectionOrder: z.number().default(129),
  verifyCommands: z.array(z.string()).default([]),
  maxRounds: z.number().min(1).default(3),
  keepWorktreeOnFailure: z.boolean().default(true),
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
1. /boost <task> — opens an ephemeral isolated worktree for the run.
2. Work streams: call boost_report with kind=implementation (code changes) or
   kind=investigation (root-cause findings, files MUST be empty).
3. /boost-verify — runs the configured verify commands inside the worktree.
   On failure it returns diagnostics for the next iteration; on success the
   run becomes verified.
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
      input: { hint: '<task — what to investigate or implement>' },
      handler: guard((invocation) => {
        const task = invocation.rawInput.trim();
        const planned = plan(task, { maxRounds: opts.maxRounds });
        if (!planned.ok) return err(`${name}: ${planned.reason}`);
        const workspace = workspaceOf(invocation.agent);
        const created = createRun(workspace, {
          task,
          verifyCommands: opts.verifyCommands,
          mode: 'implementation',
        });
        if (!created.ok) return err(`${name}: ${created.reason}`);
        const s = created.state;
        s.maxRounds = opts.maxRounds;
        return ok([
          `${name}: run ${s.runId} opened`,
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
      input: { hint: '[runId — optional]' },
      handler: guard((invocation) => {
        const workspace = workspaceOf(invocation.agent);
        const runId = invocation.rawInput.trim();
        const id = runId || latestRun(workspace);
        if (!id) return ok(`${name}: no boost run for this workspace`);
        const state = readState(workspace, id);
        if (!state) return err(`${name}: unknown run ${id}`);
        return ok(summarize(state));
      }),
    },
    {
      name: 'boost-verify',
      description: 'run one verification round; failures return diagnostics for the next iteration',
      input: { hint: '[runId — optional]' },
      handler: guard((invocation) => {
        const workspace = workspaceOf(invocation.agent);
        const runId = invocation.rawInput.trim() || latestRun(workspace);
        if (!runId) return err(`${name}: no boost run — start one with /boost <task>`);
        const outcome = iterate(workspace, runId, { verifyCommands: opts.verifyCommands });
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
      input: { hint: '<kind> <summary>  |  kind=investigation files= summary=...' },
      handler: guard((invocation) => {
        const workspace = workspaceOf(invocation.agent);
        const runId = latestRun(workspace);
        if (!runId) return err(`${name}: no boost run — start one with /boost <task>`);
        const entry = parseReport(invocation.rawInput);
        const result = report(workspace, runId, entry);
        if (!result.ok) return err(`${name}: ${result.reason}`);
        return ok(`${name}: recorded ${entry.kind} workstream for ${runId}`);
      }),
    },
    {
      name: 'boost-deliver',
      description: 'merge the verified boost branch and remove the ephemeral worktree',
      input: { hint: '[runId — optional]' },
      handler: guard((invocation) => {
        const workspace = workspaceOf(invocation.agent);
        const runId = invocation.rawInput.trim() || latestRun(workspace);
        if (!runId) return err(`${name}: no boost run`);
        const state = readState(workspace, runId);
        if (!state) return err(`${name}: unknown run ${runId}`);
        const verified = state.verifications.length > 0 && state.verifications.every((v) => v.passed);
        if (!verified) {
          return err(`${name}: run ${runId} has not passed every verification round — run /boost-verify first`);
        }
        const closed = closeRun(workspace, runId, { keepWorktree: false });
        if (!closed.ok) return err(`${name}: ${closed.reason}`);
        return ok(`${name}: verified changes merged to ${closed.target}; ephemeral worktree removed`);
      }),
    },
    {
      name: 'boost-discard',
      description: 'abort the boost run and remove the ephemeral worktree',
      input: { hint: '[runId — optional]' },
      handler: guard((invocation) => {
        const workspace = workspaceOf(invocation.agent);
        const runId = invocation.rawInput.trim() || latestRun(workspace);
        if (!runId) return err(`${name}: no boost run`);
        const removed = removeWorktree(workspace, runId);
        if (!removed.ok) return err(`${name}: ${removed.reason}`);
        return ok(`${name}: run ${runId} discarded; worktree removed`);
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
      description: 'Open an ephemeral isolated worktree for a /boost deep-reasoning run.',
      parameters: {
        task: { type: 'string', required: true, description: 'The task to investigate or implement' },
      },
      output: textOutput,
      async execute(args, exec) {
        const planned = plan(args.task, { maxRounds: opts.maxRounds });
        if (!planned.ok) return { output: planned.reason };
        const created = createRun(cwdOf(exec), { task: args.task, verifyCommands: opts.verifyCommands });
        if (!created.ok) return { output: created.reason };
        return { output: `run ${created.state.runId} opened\nworktree: ${created.state.worktree}\nbranch: ${created.state.branch}` };
      },
    }),
    defineTool({
      name: 'boost_status',
      description: 'Show the current boost run state.',
      parameters: {
        runId: { type: 'string', description: 'Boost run id; defaults to the latest run' },
      },
      output: textOutput,
      async execute(args, exec) {
        const id = args.runId || latestRun(cwdOf(exec));
        const state = id ? readState(cwdOf(exec), id) : null;
        return { output: state ? summarize(state) : 'no boost run' };
      },
    }),
    defineTool({
      name: 'boost_verify',
      description: 'Run one verification round inside the boost worktree; failures return diagnostics for the next iteration.',
      parameters: {
        runId: { type: 'string', description: 'Boost run id; defaults to the latest run' },
      },
      output: textOutput,
      async execute(args, exec) {
        const id = args.runId || latestRun(cwdOf(exec));
        if (!id) return { output: 'no boost run — start one with boost_run' };
        const outcome = iterate(cwdOf(exec), id, { verifyCommands: opts.verifyCommands });
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
      },
      output: textOutput,
      async execute(args, exec) {
        const id = latestRun(cwdOf(exec));
        if (!id) return { output: 'no boost run' };
        const result = report(cwdOf(exec), id, { kind: args.kind, summary: args.summary, files: args.files ?? [] });
        return { output: result.ok ? `recorded ${args.kind} workstream` : result.reason };
      },
    }),
    defineTool({
      name: 'boost_deliver',
      description: 'Merge the verified boost branch and remove the ephemeral worktree.',
      parameters: {
        runId: { type: 'string', description: 'Boost run id; defaults to the latest run' },
      },
      output: textOutput,
      async execute(args, exec) {
        const id = args.runId || latestRun(cwdOf(exec));
        const state = id ? readState(cwdOf(exec), id) : null;
        if (!state) return { output: 'no boost run' };
        const verified = state.verifications.length > 0 && state.verifications.every((v) => v.passed);
        if (!verified) return { output: 'run has not passed every verification round — run boost_verify first' };
        const closed = closeRun(cwdOf(exec), id, { keepWorktree: false });
        return { output: closed.ok ? `merged to ${closed.target}; worktree removed` : closed.reason };
      },
    }),
  ];

  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool), `${name}: ${tool.name}`);
  }

  ctx.logger?.info?.(`${name}: boost deep-reasoning enabled (maxRounds=${opts.maxRounds})`);
}

/** Most recently created run in this workspace. */
function latestRun(workspace) {
  const ids = listRuns(workspace);
  if (!ids.length) return null;
  return ids.sort().pop();
}

/** Parse `kind summary...` or `kind=investigation files=a,b summary=...`. */
function parseReport(raw) {
  const text = raw.trim();
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
