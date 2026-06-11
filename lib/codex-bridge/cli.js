#!/usr/bin/env node
// Bridge CLI for codex-paired-superpowers.
// As of v0.2.0, Codex itself is invoked via the bundled MCP server
// (mcp__plugin_codex-paired-superpowers_codex__codex / codex-reply).
// This CLI is responsible only for the per-feature sidecar JSON and
// (as of v0.3.0) for the active-run anchor file used by the provenance hook.
import {
  initSidecar,
  loadSidecar,
  appendRound,
  appendRoundWithAudits,
  getCodexThreadId,
  setCodexThreadId,
  buildReplayContext,
  setSlice,
  setPhase,
  setAutopilot,
  getAutopilot,
  setDependencyGraph,
  getDependencyGraph,
  setGoals,
  getGoals,
  initAppState,
  getAppState,
  markGoalShipped,
  setAppPlan,
  appendAuditLog,
  listAudits,
  hasAuditFor,
  hasExecutedVerificationFor,
  requiresExecutedVerification,
  addOpenContention,
  sidecarPathFor,
  scanStaleAutopilot,
  setLiveVerification,
  setImplementMeta,
  setImplementBootstrap,
  appendImplementDispatch,
} from './sidecar.js';
import { writeAnchor, readAnchor, clearAnchor } from './active-anchor.js';
import { parseValidationCoverage } from './validation-coverage.js';
import { parseLiveValidationCoverage } from './live-validation-coverage.js';
import { parseScenarioList } from './scenario-validator.js';
import { parseSkipFrontmatter } from './skip-frontmatter.js';
import {
  writeToMailbox,
  readMailbox,
  readUnreadMessages,
  markAsRead as mailboxMarkAsRead,
  markManyAsRead as mailboxMarkManyAsRead,
  MailboxError,
} from './mailbox.js';
import {
  writeMarker as writeHonestReportingMarker,
  readMarker as readHonestReportingMarker,
  isActive as isHonestReportingActive,
  markerPath as honestReportingMarkerPath,
  clearMarker as clearHonestReportingMarker,
} from './honest-reporting-marker.js';

// Strict message-id format matching generateMessageId() output:
//   msg-YYYY-MM-DDTHH-MM-SS-mmmZ-NNNN
// Pinned at CLI boundary: if generateMessageId changes, this regex must be
// intentionally updated alongside its tests (single canonical format source).
const MESSAGE_ID_RE = /^msg-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d{4}$/;

const [, , subcmd, ...rest] = process.argv;

/**
 * Read all of stdin as a UTF-8 string. Resolves when stdin closes.
 * @returns {Promise<string>}
 */
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/**
 * v0.15.0 — parse a required JSON flag value with an actionable error.
 * Before this, a missing flag reached JSON.parse(undefined) and crashed with
 * `SyntaxError: "undefined" is not valid JSON` and no usage hint — observed
 * live when sidecar-add-contention was invoked mid-incident without its flag.
 * A flag given without a value parses as boolean true; treat that as missing.
 */
function requireJsonArg(verb, flagName, value) {
  if (typeof value !== 'string' || value.length === 0) {
    process.stderr.write(`${verb}: --${flagName} <json> is required (flag missing or has no value)\n`);
    process.exit(2);
  }
  try {
    return JSON.parse(value);
  } catch (e) {
    process.stderr.write(`${verb}: --${flagName} is not valid JSON: ${e.message}\n`);
    process.exit(2);
  }
}

const subcommands = {
  'sidecar-init'({ specPath, feature, threadId, model, reasoning }) {
    const sc = initSidecar(specPath, {
      feature,
      codexSession: threadId,
      model: model || 'gpt-5.5',
      reasoningEffort: reasoning || 'high',
    });
    process.stdout.write(JSON.stringify(sc, null, 2));
  },
  'sidecar-path'({ specPath }) {
    process.stdout.write(sidecarPathFor(specPath));
  },
  'sidecar-show'({ specPath }) {
    process.stdout.write(JSON.stringify(loadSidecar(specPath), null, 2));
  },
  'sidecar-thread-id'({ specPath, role }) {
    // v0.13.0: route through getCodexThreadId so mixed v0.9+ sidecars resolve the canonical
    // role_sessions value (falling back to legacy codex_session) rather than a raw field read.
    process.stdout.write(getCodexThreadId(loadSidecar(specPath), role || 'paired-reviewer') ?? '');
  },
  async 'sidecar-rotate-thread-id'({ specPath, role, oldThreadId, newThreadId, reason, phase, round }) {
    const r = Number.isInteger(Number(round)) && round !== undefined && round !== true ? Number(round) : undefined;
    await setCodexThreadId(specPath, {
      role: role || 'paired-reviewer', oldThreadId, newThreadId, reason: reason || 'session-not-found', phase, round: r,
    });
  },
  'sidecar-replay-context'({ specPath }) {
    process.stdout.write(JSON.stringify(buildReplayContext(specPath), null, 2));
  },
  /**
   * v0.15.0 — the round is validated in the sink (sidecar.js):
   *   - shape: phase must be a non-empty string, round a positive integer
   *     (a bad caller once pushed bare integers into rounds[], corrupting
   *     the sidecar for every later consumer);
   *   - sequence: round must be max(existing for phase) + 1; pass
   *     --force-round to override after user approval;
   *   - budget: rounds beyond the 7-round budget are refused; start a new
   *     phase key (e.g. plan-2) for new logical work, or pass
   *     --allow-over-budget after the user explicitly approves;
   *   - SHIP audits: a SHIP verdict in a design/code-bearing phase requires
   *     the audit evidence previously (and leakily) checked by the
   *     PreToolUse hook's shell-string regex.
   */
  'sidecar-append-round'(args) {
    const round = requireJsonArg('sidecar-append-round', 'round', args.round);
    appendRound(args.specPath, round, {
      sequential: args['force-round'] !== true,
      budget: args['allow-over-budget'] !== true,
      enforceShipAudits: true,
    });
  },
  async 'sidecar-append-round-with-audits'(args) {
    let body = args.payload;
    if (typeof body !== 'string' || body.length === 0) {
      body = await readStdin();
    }
    if (typeof body !== 'string' || body.length === 0) {
      process.stderr.write('sidecar-append-round-with-audits: --payload JSON or stdin required\n');
      process.exit(2);
    }
    await appendRoundWithAudits(args.specPath, requireJsonArg('sidecar-append-round-with-audits', 'payload', body), {
      sequential: args['force-round'] !== true,
      budget: args['allow-over-budget'] !== true,
    });
  },
  'sidecar-set-slice'({ specPath, sliceId, state }) {
    setSlice(specPath, sliceId, requireJsonArg('sidecar-set-slice', 'state', state));
  },
  'sidecar-set-phase'({ specPath, sliceId, phase, state }) {
    setPhase(specPath, sliceId, phase, requireJsonArg('sidecar-set-phase', 'state', state));
  },
  'sidecar-set-autopilot'({ specPath, block }) {
    setAutopilot(specPath, requireJsonArg('sidecar-set-autopilot', 'block', block));
  },
  'sidecar-get-autopilot'({ specPath }) {
    const ap = getAutopilot(specPath);
    process.stdout.write(ap ? JSON.stringify(ap, null, 2) : '');
  },
  /**
   * v0.15.0 — list in-flight autopilot runs (halt_reason null) that have
   * gone quiet for more than --max-age-hours (default 24). Skills run this
   * at entry and surface results so an abandoned run can't sit silently
   * resumable for days. Emits a JSON array (empty array when clean).
   */
  'sidecar-scan-stale'({ repoRoot, 'max-age-hours': maxAgeHours }) {
    const root = (typeof repoRoot === 'string' && repoRoot.length > 0) ? repoRoot : process.cwd();
    const opts = {};
    const parsed = Number(maxAgeHours);
    if (Number.isFinite(parsed) && parsed > 0) opts.maxAgeHours = parsed;
    process.stdout.write(JSON.stringify(scanStaleAutopilot(root, opts), null, 2));
  },
  'sidecar-add-contention'({ specPath, contention }) {
    addOpenContention(specPath, requireJsonArg('sidecar-add-contention', 'contention', contention));
  },
  /**
   * Set one or more keys in the live-verification phase block for a slice.
   * Accepts --sliceId and --block (JSON object whose keys are merged into the live-verification block).
   * Example: cli sidecar-set-live-verification --specPath ... --sliceId slice-1 --block '{"shipped":true}'
   */
  'sidecar-set-live-verification'({ specPath, sliceId, block }) {
    const updates = requireJsonArg('sidecar-set-live-verification', 'block', block);
    for (const [key, value] of Object.entries(updates)) {
      setLiveVerification(specPath, sliceId, key, value);
    }
  },
  /**
   * v0.7.0: write implement-phase routing/parallel/worktree metadata.
   * --meta is a JSON object with keys: preferred_implementer, fallback_implementer,
   * parallel_group, parallel_suppressed_reason, worktree.
   */
  'sidecar-set-implement-meta'({ specPath, sliceId, meta }) {
    setImplementMeta(specPath, sliceId, requireJsonArg('sidecar-set-implement-meta', 'meta', meta));
  },
  /**
   * v0.7.0: write implement-phase bootstrap record.
   * --bootstrap is a JSON object with keys: symlinks (array), completed_at (ISO string).
   */
  'sidecar-set-implement-bootstrap'({ specPath, sliceId, bootstrap }) {
    setImplementBootstrap(specPath, sliceId, requireJsonArg('sidecar-set-implement-bootstrap', 'bootstrap', bootstrap));
  },
  /**
   * v0.7.0: append an implement-phase dispatch record (append-only).
   * --dispatch is a JSON object; required: slice_id, agent, dispatched_at, worktree, outcome.
   */
  'sidecar-append-implement-dispatch'({ specPath, sliceId, dispatch }) {
    appendImplementDispatch(specPath, sliceId, requireJsonArg('sidecar-append-implement-dispatch', 'dispatch', dispatch));
  },
  /**
   * v0.7.3: set autopilot.dependency_graph block (used by Phase B.PRE on session start).
   * --graph is a JSON object: { digest: string, dag: object }
   */
  'sidecar-set-dependency-graph'({ specPath, graph }) {
    setDependencyGraph(specPath, requireJsonArg('sidecar-set-dependency-graph', 'graph', graph));
  },
  /**
   * v0.7.3: read persisted autopilot.dependency_graph block (used by Phase B.PRE
   * on subsequent calls + resume to decide write-vs-verify path).
   * Emits the block as JSON on stdout, or empty string if absent.
   */
  'sidecar-get-dependency-graph'({ specPath }) {
    const block = getDependencyGraph(specPath);
    process.stdout.write(block ? JSON.stringify(block) : '');
  },
  /**
   * v0.10.1: persist the user-goals block (the `<<<GOALS>>>...<<<END_GOALS>>>`
   * text). Read by writing-plans / brainstorming on every round so Codex
   * critiques against the user's stated outcome, not against the artifact.
   *
   * --block is the verbatim goals-block text (pass via stdin or escaped flag).
   */
  async 'sidecar-set-goals'({ specPath, block }) {
    let body = block;
    if (typeof body !== 'string' || body.length === 0) {
      body = await readStdin();
    }
    if (typeof body !== 'string' || body.length === 0) {
      process.stderr.write('sidecar-set-goals: --block or stdin required\n');
      process.exit(2);
    }
    setGoals(specPath, { block: body });
  },
  'sidecar-get-goals'({ specPath }) {
    const g = getGoals(specPath);
    process.stdout.write(g ? JSON.stringify(g) : '');
  },
  /**
   * v0.11.0 — initialize the app_state block from an array of goals.
   * Goals are { id, text } pairs the orchestrator extracts from the
   * <<<GOALS>>> block. Pass as JSON via --goals or stdin.
   */
  async 'app-state-init'({ specPath, goals }) {
    let body = goals;
    if (typeof body !== 'string' || body.length === 0) {
      body = await readStdin();
    }
    if (typeof body !== 'string' || body.length === 0) {
      process.stderr.write('app-state-init: --goals JSON or stdin required\n');
      process.exit(2);
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      process.stderr.write(`app-state-init: invalid JSON: ${e.message}\n`);
      process.exit(2);
    }
    if (!Array.isArray(parsed)) {
      process.stderr.write('app-state-init: goals must be a JSON array of {id, text}\n');
      process.exit(2);
    }
    const result = initAppState(specPath, { goals: parsed });
    process.stdout.write(JSON.stringify(result, null, 2));
  },
  /**
   * v0.11.0 — read the app_state block. Emits empty string if never initialized.
   */
  'app-state-get'({ specPath }) {
    const s = getAppState(specPath);
    process.stdout.write(s ? JSON.stringify(s, null, 2) : '');
  },
  /**
   * v0.11.0 — mark one goal as audited-shipped by a plan. Idempotent.
   */
  'app-state-mark-goal-shipped'({ specPath, goalId, planPath }) {
    if (typeof goalId !== 'string' || goalId.length === 0) {
      process.stderr.write('app-state-mark-goal-shipped: --goalId required\n');
      process.exit(2);
    }
    if (typeof planPath !== 'string' || planPath.length === 0) {
      process.stderr.write('app-state-mark-goal-shipped: --planPath required\n');
      process.exit(2);
    }
    const result = markGoalShipped(specPath, { goalId, planPath });
    process.stdout.write(JSON.stringify(result, null, 2));
  },
  /**
   * v0.11.0 — record plan lifecycle (started / shipped). Pass --started or
   * --shipped (flags, no value), referring to the plan at --planPath.
   */
  'app-state-set-plan'(args) {
    if (typeof args.planPath !== 'string' || args.planPath.length === 0) {
      process.stderr.write('app-state-set-plan: --planPath required\n');
      process.exit(2);
    }
    const result = setAppPlan(args.specPath, {
      planPath: args.planPath,
      started: args.started === true,
      shipped: args.shipped === true,
    });
    process.stdout.write(JSON.stringify(result, null, 2));
  },
  /**
   * v0.11.0 — emit the context bundle for the next-plan-picking Claude↔Codex
   * round: unshipped goals, shipped-plans summary, active plan (if any).
   * The orchestrator concatenates this with the goals block + repo state to
   * build the round-1 prompt for writing-plans.
   */
  'app-state-next-plan-context'({ specPath }) {
    const s = getAppState(specPath);
    if (!s) {
      process.stderr.write('app-state-next-plan-context: app_state not initialized\n');
      process.exit(2);
    }
    const unshipped = s.goals.filter((g) => !g.audited_shipped);
    const shipped = s.goals.filter((g) => g.audited_shipped);
    process.stdout.write(JSON.stringify({
      unshipped_goals: unshipped.map((g) => ({ id: g.id, text: g.text })),
      shipped_goals: shipped.map((g) => ({ id: g.id, text: g.text, by_plan: g.shipped_by_plan })),
      shipped_plans: s.plans.filter((p) => p.shipped).map((p) => ({ path: p.path, audited_goals: p.audited_goals })),
      active_plan: s.active_plan,
      total_goals: s.goals.length,
      goals_shipped_count: shipped.length,
    }, null, 2));
  },
  /**
   * v0.10.1: append a structured audit-log entry. Used by writing-plans /
   * brainstorming when Codex (or Claude) reports the commands it ran to
   * verify the artifact against the codebase. Indexed by (phase, round, side).
   *
   * --audit is a JSON object: { phase, round, side, commands[], verdict_basis? }.
   * Pass via flag or stdin.
   */
  async 'sidecar-append-audit'({ specPath, audit }) {
    let body = audit;
    if (typeof body !== 'string' || body.length === 0) {
      body = await readStdin();
    }
    if (typeof body !== 'string' || body.length === 0) {
      process.stderr.write('sidecar-append-audit: --audit JSON or stdin required\n');
      process.exit(2);
    }
    appendAuditLog(specPath, requireJsonArg('sidecar-append-audit', 'audit', body));
  },
  /**
   * v0.10.1: list audit-log entries, optionally filtered by --phase / --round / --side.
   */
  'sidecar-list-audits'({ specPath, phase, round, side }) {
    const filter = {};
    if (typeof phase === 'string' && phase.length > 0) filter.phase = phase;
    if (round !== undefined) {
      const n = Number(round);
      if (Number.isInteger(n)) filter.round = n;
    }
    if (typeof side === 'string' && side.length > 0) filter.side = side;
    process.stdout.write(JSON.stringify(listAudits(specPath, filter), null, 2));
  },
  /**
   * v0.10.1: query whether a (phase, round, side) triple has an audit. Used by
   * the honest-reporting Stop-gate. Emits `true` or `false`.
   */
  'sidecar-has-audit'({ specPath, phase, round, side }) {
    const n = Number(round);
    if (!Number.isInteger(n)) {
      process.stderr.write('sidecar-has-audit: --round must be an integer\n');
      process.exit(2);
    }
    process.stdout.write(JSON.stringify(hasAuditFor(specPath, { phase, round: n, side })));
  },
  'sidecar-has-executed-verification'({ specPath, phase, round, side }) {
    const n = Number(round);
    if (!Number.isInteger(n)) {
      process.stderr.write('sidecar-has-executed-verification: --round must be an integer\n');
      process.exit(2);
    }
    process.stdout.write(JSON.stringify(hasExecutedVerificationFor(specPath, { phase, round: n, side })));
  },
  'sidecar-requires-verification'({ phase }) {
    process.stdout.write(JSON.stringify(requiresExecutedVerification(phase)));
  },
  'anchor-write'({ repoRoot, specPath }) {
    writeAnchor(repoRoot, specPath);
  },
  'anchor-read'({ repoRoot }) {
    const a = readAnchor(repoRoot);
    process.stdout.write(a ? JSON.stringify(a) : '');
  },
  'anchor-clear'({ repoRoot }) {
    clearAnchor(repoRoot);
  },

  // v0.8.1 honest-reporting marker subcommands.
  //
  // Activate: skill entry blocks invoke `honest-reporting-mark-active --skill <name> [--spec <path>] [--ttl-hours N]`
  // to write <repo-root>/.codex-paired/honest-reporting-active.json. The Stop
  // and PreToolUse hooks check this file (with expiresAt TTL) to decide
  // whether to activate. See skills/honest-reporting/SKILL.md and the spec
  // at docs/specs/2026-05-11-v0.8.1-peer-dm-and-honest-reporting.md.
  'honest-reporting-mark-active'({ skill, spec, 'ttl-hours': ttlHours, cwd }) {
    const startDir = (typeof cwd === 'string' && cwd.length > 0) ? cwd : process.cwd();
    if (typeof skill !== 'string' || skill.length === 0) {
      process.stderr.write('honest-reporting-mark-active: --skill <name> required\n');
      process.exit(2);
    }
    const opts = { skillName: skill };
    if (typeof spec === 'string' && spec.length > 0) opts.specPath = spec;
    if (ttlHours !== undefined) {
      const parsed = Number(ttlHours);
      if (Number.isFinite(parsed) && parsed > 0) opts.ttlHours = parsed;
    }
    const { path, marker } = writeHonestReportingMarker(startDir, opts);
    process.stdout.write(JSON.stringify({ path, marker }, null, 2));
  },
  /**
   * v0.15.0 — deactivate the honest-reporting hook. Workflow skills call
   * this on completion/halt (mirroring anchor-clear) so the 8h TTL stops
   * being the only deactivation path and the hook no longer polices
   * unrelated work in the same repo for hours after a workflow ends.
   */
  'honest-reporting-clear'({ cwd }) {
    const startDir = (typeof cwd === 'string' && cwd.length > 0) ? cwd : process.cwd();
    process.stdout.write(JSON.stringify(clearHonestReportingMarker(startDir), null, 2));
  },
  'honest-reporting-read-marker'({ cwd }) {
    const startDir = (typeof cwd === 'string' && cwd.length > 0) ? cwd : process.cwd();
    const m = readHonestReportingMarker(startDir);
    process.stdout.write(m ? JSON.stringify(m, null, 2) : '');
  },
  'honest-reporting-is-active'({ cwd }) {
    const startDir = (typeof cwd === 'string' && cwd.length > 0) ? cwd : process.cwd();
    process.stdout.write(JSON.stringify(isHonestReportingActive(startDir), null, 2));
  },
  'honest-reporting-marker-path'({ cwd }) {
    const startDir = (typeof cwd === 'string' && cwd.length > 0) ? cwd : process.cwd();
    process.stdout.write(honestReportingMarkerPath(startDir));
  },
  async 'validation-parse'({ tier }) {
    const raw = await readStdin();
    let critique;
    try {
      critique = JSON.parse(raw);
    } catch (e) {
      process.stderr.write(JSON.stringify({ defect: 'invalid-json-input', detail: e.message }));
      process.exit(2);
    }
    const result = parseValidationCoverage(critique, tier ? { tier } : {});
    if (result.ok) {
      process.stdout.write(JSON.stringify({ tier: result.tier, coverage: result.coverage }));
      process.exit(0);
    } else {
      process.stderr.write(JSON.stringify({ defect: result.defect, detail: result.detail || '' }));
      process.exit(2);
    }
  },
  async 'scenario-validate'({ 'require-scenarios': requireScenariosFlag }) {
    const raw = await readStdin();
    const opts = {};
    if (requireScenariosFlag !== undefined) {
      opts.requireScenarios = true;
    }
    const result = parseScenarioList(raw, opts);
    if (result.ok) {
      process.stdout.write(JSON.stringify({ ok: true, scenarios: result.scenarios, deferred: result.deferred }));
      process.exit(0);
    } else {
      process.stderr.write(JSON.stringify({ defect: result.defect, detail: result.detail || '' }));
      process.exit(2);
    }
  },
  async 'parse-skip-frontmatter'() {
    const sliceMarkdown = await readStdin();
    const result = parseSkipFrontmatter(sliceMarkdown);
    if (result.error) {
      process.stderr.write(JSON.stringify({ defect: result.error.code, detail: result.error.detail }));
      process.exit(2);
    } else {
      process.stdout.write(JSON.stringify(result));
      process.exit(0);
    }
  },
  async 'live-validation-parse'({ tier }) {
    const raw = await readStdin();
    let critique;
    try {
      critique = JSON.parse(raw);
    } catch (e) {
      process.stderr.write(JSON.stringify({ defect: 'invalid-json-input', detail: e.message }));
      process.exit(2);
    }
    const result = parseLiveValidationCoverage(critique, tier ? { tier } : {});
    if (result.ok) {
      process.stdout.write(JSON.stringify({ tier: result.tier, coverage: result.coverage }));
      process.exit(0);
    } else {
      process.stderr.write(JSON.stringify({ defect: result.defect, detail: result.detail || '' }));
      process.exit(2);
    }
  },

  // ── v0.7.3 mailbox CLI subcommands ─────────────────────────────────────────
  // mailbox-write: --to <recipient> --from <sender> [--text "..."| --text-stdin
  //                | --message-json-stdin] [--summary "..."] [--color "..."]
  //                [--repoRoot <path>]  (defaults to process.cwd())
  async 'mailbox-write'(args) {
    const repoRoot = args.repoRoot || process.cwd();
    if (!args.to) { process.stderr.write(JSON.stringify({ defect: 'missing-arg', detail: '--to required' })); process.exit(2); }
    if (!args.from) { process.stderr.write(JSON.stringify({ defect: 'missing-arg', detail: '--from required' })); process.exit(2); }
    let message;
    try {
      if ('message-json-stdin' in args) {
        const raw = await readStdin();
        const parsed = JSON.parse(raw);
        // The recipient/from in JSON must agree with CLI args (defense)
        message = { ...parsed, from: args.from };
      } else if ('text-stdin' in args) {
        const raw = await readStdin();
        message = { from: args.from, text: raw };
        if (args.summary !== undefined) message.summary = args.summary;
        if (args.color !== undefined) message.color = args.color;
      } else if (args.text !== undefined) {
        message = { from: args.from, text: args.text };
        if (args.summary !== undefined) message.summary = args.summary;
        if (args.color !== undefined) message.color = args.color;
      } else {
        process.stderr.write(JSON.stringify({ defect: 'missing-arg', detail: 'one of --text / --text-stdin / --message-json-stdin required' }));
        process.exit(2);
      }
    } catch (e) {
      process.stderr.write(JSON.stringify({ defect: 'invalid-json-input', detail: e.message }));
      process.exit(2);
    }
    try {
      const result = await writeToMailbox(repoRoot, args.to, message);
      process.stdout.write(JSON.stringify(result));
      process.exit(0);
    } catch (e) {
      if (e instanceof MailboxError) {
        process.stderr.write(JSON.stringify({ defect: e.code, detail: e.message }));
        process.exit(2);
      }
      process.stderr.write(JSON.stringify({ defect: 'mailbox-write-failed', detail: e.message }));
      process.exit(1);
    }
  },

  // mailbox-read: --for <recipient> --actor <orchestrator|slice-N>
  //               [--unread] [--json] [--repoRoot <path>]
  async 'mailbox-read'(args) {
    const repoRoot = args.repoRoot || process.cwd();
    if (!args.for) { process.stderr.write(JSON.stringify({ defect: 'missing-arg', detail: '--for required' })); process.exit(2); }
    if (!args.actor) { process.stderr.write(JSON.stringify({ defect: 'missing-arg', detail: '--actor required for mailbox-read' })); process.exit(2); }
    // Permission check: actor must equal the inbox owner OR be 'orchestrator'.
    if (args.actor !== 'orchestrator' && args.actor !== args.for) {
      process.stderr.write(JSON.stringify({
        defect: 'mailbox-permission-denied',
        detail: `actor="${args.actor}" cannot read inbox "${args.for}" (only orchestrator or "${args.for}" itself may read)`,
      }));
      process.exit(2);
    }
    try {
      const messages = 'unread' in args
        ? await readUnreadMessages(repoRoot, args.for)
        : await readMailbox(repoRoot, args.for);
      process.stdout.write(JSON.stringify(messages, null, 'json' in args ? 2 : undefined));
      process.exit(0);
    } catch (e) {
      if (e instanceof MailboxError) {
        process.stderr.write(JSON.stringify({ defect: e.code, detail: e.message }));
        process.exit(2);
      }
      process.stderr.write(JSON.stringify({ defect: 'mailbox-read-failed', detail: e.message }));
      process.exit(1);
    }
  },

  // mailbox-mark-read: --for <recipient> --actor <orchestrator|slice-N> --id <message-id>
  async 'mailbox-mark-read'(args) {
    const repoRoot = args.repoRoot || process.cwd();
    if (!args.for) { process.stderr.write(JSON.stringify({ defect: 'missing-arg', detail: '--for required' })); process.exit(2); }
    if (!args.actor) { process.stderr.write(JSON.stringify({ defect: 'missing-arg', detail: '--actor required' })); process.exit(2); }
    if (!args.id) { process.stderr.write(JSON.stringify({ defect: 'missing-arg', detail: '--id required' })); process.exit(2); }
    if (args.actor !== 'orchestrator' && args.actor !== args.for) {
      process.stderr.write(JSON.stringify({
        defect: 'mailbox-permission-denied',
        detail: `actor="${args.actor}" cannot mark messages read in inbox "${args.for}"`,
      }));
      process.exit(2);
    }
    try {
      const result = await mailboxMarkAsRead(repoRoot, args.for, args.id);
      process.stdout.write(JSON.stringify(result));
      process.exit(0);
    } catch (e) {
      if (e instanceof MailboxError) {
        process.stderr.write(JSON.stringify({ defect: e.code, detail: e.message }));
        process.exit(2);
      }
      process.stderr.write(JSON.stringify({ defect: 'mailbox-mark-read-failed', detail: e.message }));
      process.exit(1);
    }
  },

  // mailbox-mark-read-batch: --for <recipient> --actor <orchestrator|slice-N>
  //                         --message-ids <id1,id2,...> [--repoRoot <path>]
  // Single lockfile acquisition for the whole batch. Unknown well-formed ids
  // are skipped (idempotent). Malformed ids reject the whole batch before any
  // helper invocation (no partial mutation).
  async 'mailbox-mark-read-batch'(args) {
    const repoRoot = args.repoRoot || process.cwd();
    if (!args.for) { process.stderr.write(JSON.stringify({ defect: 'missing-arg', detail: '--for required' })); process.exit(2); }
    if (!args.actor) { process.stderr.write(JSON.stringify({ defect: 'missing-arg', detail: '--actor required' })); process.exit(2); }
    if (args['message-ids'] === undefined || args['message-ids'] === true) {
      process.stderr.write(JSON.stringify({ defect: 'missing-arg', detail: '--message-ids required' }));
      process.exit(2);
    }
    if (args.actor !== 'orchestrator' && args.actor !== args.for) {
      process.stderr.write(JSON.stringify({
        defect: 'mailbox-permission-denied',
        detail: `actor="${args.actor}" cannot mark messages read in inbox "${args.for}"`,
      }));
      process.exit(2);
    }

    const raw = String(args['message-ids']);
    if (raw.length === 0) {
      process.stderr.write(JSON.stringify({
        defect: 'invalid-message-ids',
        detail: '--message-ids must be non-empty',
      }));
      process.exit(2);
    }
    const parts = raw.split(',').map(s => s.trim());
    for (const part of parts) {
      if (part.length === 0) {
        process.stderr.write(JSON.stringify({
          defect: 'invalid-message-ids',
          detail: '--message-ids contains an empty part (after whitespace trim)',
        }));
        process.exit(2);
      }
      if (!MESSAGE_ID_RE.test(part)) {
        process.stderr.write(JSON.stringify({
          defect: 'invalid-message-ids',
          detail: `id "${part}" does not match required format msg-YYYY-MM-DDTHH-MM-SS-mmmZ-NNNN`,
        }));
        process.exit(2);
      }
    }

    try {
      const result = await mailboxMarkManyAsRead(repoRoot, args.for, parts);
      process.stdout.write(JSON.stringify(result));
      process.exit(0);
    } catch (e) {
      if (e instanceof MailboxError) {
        process.stderr.write(JSON.stringify({ defect: e.code, detail: e.message }));
        process.exit(2);
      }
      process.stderr.write(JSON.stringify({ defect: 'mailbox-mark-read-batch-failed', detail: e.message }));
      process.exit(1);
    }
  },
};

function parseArgs(rest) {
  const out = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i].replace(/^--/, '');
    const nextVal = rest[i + 1];
    // If the next element is absent or starts with '--', treat this flag as boolean true.
    if (nextVal === undefined || nextVal.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = nextVal;
      i++; // consume the value
    }
  }
  return out;
}

const fn = subcommands[subcmd];
if (!fn) {
  console.error(`unknown subcommand: ${subcmd}`);
  console.error(`available: ${Object.keys(subcommands).join(', ')}`);
  process.exit(2);
}
Promise.resolve(fn(parseArgs(rest))).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
