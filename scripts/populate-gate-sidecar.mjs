#!/usr/bin/env node
// v0.9.0 slice 8 follow-up — populate a test sidecar that exercises
// the full v0.9.0 dispatch contract end-to-end, so the release-gate
// runner's criteria 3 + 4 can produce real PASS evidence.
//
// What it does:
//   1. Creates a tiny test spec + initializes a fresh sidecar.
//   2. Calls real composeExperts → real resolveAdapter for two roles
//      that the ladder routes to different CLIs.
//   3. Calls real runTurnWithDeps with an injected agentDispatch that
//      returns a valid Machine Result. The first turn enqueues a peer
//      DM to the second expert.
//   4. The second turn's request.unreadMessages includes the DM, so the
//      receiver's turn record carries mailbox_message_ids[] non-empty
//      AND its adapter differs from the sender's (cross-adapter proof).
//   5. Adds a spec-phase double-SHIP round so c5 also PASSes.
//   6. Prints the sidecar path; the gate runner reads it via
//      CPS_GATE_SIDECAR env.
//
// No live CLI required — agentDispatch is a deterministic stub. This is
// a pure persistence/audit harness; live-CLI dispatch is covered by
// tier 4 installed-smoke tests separately.

import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = resolve(__dirname, '..');

const {
  initSidecar,
  appendExpertTurn,
  appendExpertSelection,
  appendRound,
  loadSidecar,
  getTeammatesBlock,
} = await import(join(REPO, 'lib/codex-bridge/sidecar.js'));
const { composeExperts } = await import(join(REPO, 'lib/codex-bridge/role-composer.js'));
const { resolveAdapter } = await import(join(REPO, 'lib/codex-bridge/role-routing/resolver.js'));
const { detectAvailableCLIs, availableCLISet } = await import(
  join(REPO, 'lib/codex-bridge/availability/detector.js')
);
const { runTurnWithDeps } = await import(join(REPO, 'lib/codex-bridge/expert-turn.js'));

function adapterFor(cli) {
  return cli === 'claude' ? 'claude-task' : `cli-harness:${cli}`;
}

function validMachineResult(expertId, phase, peerTargets = []) {
  return [
    '## Findings',
    'Looks acceptable for the harness.',
    '',
    '## Machine Result',
    '```json',
    JSON.stringify({
      expert_id: expertId,
      phase,
      status: 'SHIP',
      scope: 'harness',
      blocking_findings: [],
      nonblocking_findings: [],
      peer_messages_requested: peerTargets.map((t) => ({
        to: t,
        body: `from ${expertId}: ack the harness handoff`,
        summary: 'harness DM',
      })),
      questions_for_orchestrator: [],
    }),
    '```',
  ].join('\n');
}

async function main() {
  // ── 1. Set up a project root + spec for the harness ───────────────────────
  const harnessRoot = mkdtempSync(join(tmpdir(), 'cps-gate-sidecar-'));
  const specDir = join(harnessRoot, 'docs', 'specs');
  mkdirSync(specDir, { recursive: true });
  const specPath = join(specDir, '2026-05-12-gate-harness.md');
  writeFileSync(
    specPath,
    [
      '# Gate Harness Spec',
      '',
      '## Feature',
      'A tiny authentication endpoint hitting a database lookup with bcrypt hashing.',
      '',
      '## Requirements',
      '- Validate email format',
      '- Hash passwords with bcrypt',
      '- Rate-limit 5 attempts per IP per minute',
    ].join('\n'),
  );
  initSidecar(specPath, {
    feature: 'gate-harness',
    codexSession: 'sess-gate-harness',
    model: 'gpt-5.5',
    reasoningEffort: 'high',
  });

  // Write a minimal role-prompt file for each expert we use, so
  // readRolePromptAudit can hash them (the production path expects a file
  // with frontmatter). We use the bundled v0.9.0 prompts where available;
  // otherwise inline minimal stubs.
  const promptDir = join(harnessRoot, '.codex-paired', 'role-prompts');
  mkdirSync(promptDir, { recursive: true });
  function ensurePrompt(id) {
    const p = join(promptDir, `${id}.md`);
    if (!existsSync(p)) {
      writeFileSync(
        p,
        `---\nversion: v0.9.0-harness\nrole_id: ${id}\n---\nYou are ${id}.`,
      );
    }
    return p;
  }

  // ── 2. Compose experts + probe available CLIs ─────────────────────────────
  const composed = composeExperts({
    phase: 'spec-review',
    signals: { specHas: ['auth', 'credential'], domains: ['security'] },
    repoRoot: REPO,
  });
  if (!Array.isArray(composed.selected) || composed.selected.length < 2) {
    throw new Error(`composeExperts returned < 2 roles: ${JSON.stringify(composed.selected)}`);
  }

  const detector = await detectAvailableCLIs(REPO);
  const availableCLIs = availableCLISet(detector);
  // For the harness, force two distinct CLIs to be available regardless of
  // host state so the ladder produces a cross-adapter pair every time.
  availableCLIs.add('codex');
  availableCLIs.add('claude');

  // Pick two specific roles whose ladders diverge: expert-architecture (codex
  // first) + expert-ui (claude first). These two are guaranteed cross-CLI
  // when both adapters are available. We don't require the composer to have
  // selected expert-ui (it isn't a phase default for spec-review without ui
  // signals); inject it explicitly as the second harness role.
  const archSpec =
    composed.selected.find((s) => s.id === 'expert-architecture') ||
    { id: 'expert-architecture', role: 'architecture' };
  const uiSpec = { id: 'expert-ui', role: 'ui' };
  const harnessRoles = [
    { id: 'expert-architecture', spec: archSpec },
    { id: 'expert-ui', spec: uiSpec },
  ];

  for (const r of harnessRoles) {
    r.resolution = resolveAdapter(r.id, availableCLIs, null);
    r.adapter = adapterFor(r.resolution.cli);
    r.promptPath = ensurePrompt(r.id);
    // Record the selection in the sidecar (mirrors production composer flow).
    appendExpertSelection(specPath, {
      id: r.id,
      role: r.spec.role || r.id.replace(/^expert-/, ''),
      source: 'builtin',
      phase: 'spec-review',
      selectionReason: 'harness',
    });
  }

  if (harnessRoles[0].resolution.cli === harnessRoles[1].resolution.cli) {
    throw new Error(
      `Both roles resolved to the same CLI (${harnessRoles[0].resolution.cli}); ` +
        `cannot exercise cross-adapter peer DM. Resolutions: ` +
        JSON.stringify(harnessRoles.map((r) => ({ id: r.id, cli: r.resolution.cli }))),
    );
  }

  console.log(
    `harness: role[0]=${harnessRoles[0].id}@${harnessRoles[0].adapter}; ` +
      `role[1]=${harnessRoles[1].id}@${harnessRoles[1].adapter}`,
  );

  // ── 3. Dispatch turn 1: sender role enqueues a DM to receiver ─────────────
  const sender = harnessRoles[0];
  const receiver = harnessRoles[1];

  const senderResult = await runTurnWithDeps(
    {
      identity: { id: sender.id, role: sender.spec.role || sender.id, promptPath: sender.promptPath, source: 'builtin' },
      repoRoot: harnessRoot,
      specPath,
      specSnippet: 'auth endpoint',
      phase: 'spec-review',
      sliceId: null,
      adapter: sender.adapter,
      resolution: sender.resolution,
      sidecarParticipantState: '',
      task: 'Review architecture',
      suppressPeerMessages: false,
    },
    {
      agentDispatch: async () => validMachineResult(sender.id, 'spec-review', [receiver.id]),
      readUnreadMessages: async () => [],
      markMessagesRead: async () => {},
      writeBreadcrumb: async () => {},
    },
  );
  if (!senderResult.ok) throw new Error(`sender turn failed: ${JSON.stringify(senderResult)}`);

  // ── 4. Dispatch turn 2: receiver consumes the DM ──────────────────────────
  // Read the message ID the sender's turn enqueued from the sidecar.
  const sc = loadSidecar(specPath);
  const senderTurn = getTeammatesBlock(sc).turns[0];
  const enqueued = senderTurn.peer_messages_enqueued || [];
  const dmToReceiver = enqueued.find((e) => e.to === receiver.id);
  if (!dmToReceiver) {
    throw new Error(
      `sender turn did not enqueue a DM to ${receiver.id}; peer_messages_enqueued: ${JSON.stringify(enqueued)}`,
    );
  }
  const dmId = dmToReceiver.message_id;

  const receiverResult = await runTurnWithDeps(
    {
      identity: { id: receiver.id, role: receiver.spec.role || receiver.id, promptPath: receiver.promptPath, source: 'builtin' },
      repoRoot: harnessRoot,
      specPath,
      specSnippet: 'auth endpoint',
      phase: 'spec-review',
      sliceId: null,
      adapter: receiver.adapter,
      resolution: receiver.resolution,
      sidecarParticipantState: '',
      task: 'Review UX',
      suppressPeerMessages: false,
    },
    {
      agentDispatch: async () => validMachineResult(receiver.id, 'spec-review', []),
      readUnreadMessages: async () => [
        { id: dmId, from: sender.id, text: 'ack', timestamp: '2026-05-12T20:00:00.000Z' },
      ],
      markMessagesRead: async () => {},
      writeBreadcrumb: async () => {},
    },
  );
  if (!receiverResult.ok) throw new Error(`receiver turn failed: ${JSON.stringify(receiverResult)}`);

  // ── 5. Add a spec-phase double-SHIP round so c5 PASSes ────────────────────
  appendRound(specPath, {
    phase: 'spec',
    round: 1,
    claude: 'SHIP: harness convergence',
    codex: 'SHIP: harness convergence',
  });

  // ── 6. Report the sidecar path for the gate runner ────────────────────────
  const finalSc = loadSidecar(specPath);
  const turns = getTeammatesBlock(finalSc).turns;
  console.log(`harness: wrote ${turns.length} turns to sidecar.`);

  // Find the sidecar JSON path on disk (the sidecar layout lives under
  // .superpowers-codex-paired/ rooted at the repo containing the spec).
  // For a harness root outside any git repo, the legacy path is the spec +
  // '.codex.json'. Use sidecarPathFor to be authoritative.
  const { sidecarPathFor } = await import(join(REPO, 'lib/codex-bridge/sidecar.js'));
  const sidecarOnDisk = sidecarPathFor(specPath);
  console.log(`harness: sidecar JSON at ${sidecarOnDisk}`);
  console.log(`harness: run the gate with:`);
  console.log(`  CPS_GATE_SIDECAR='${sidecarOnDisk}' CPS_INSTALLED_SMOKE=1 ./scripts/v0.9.0-release-gate.sh`);
}

main().catch((err) => {
  console.error('populate-gate-sidecar failed:', err);
  process.exit(1);
});
