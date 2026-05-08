import { appendRound } from './sidecar.js';
import { parseVerdict } from './verdict.js';

const DEFAULT_MAX_ROUNDS = 7;

/**
 * Run the Claude<->Codex round loop until both ship or maxRounds is hit.
 *
 * Round semantics: one round = one Codex artifact + one Claude verdict on it.
 *   - Round 1: codexFn returns the initial draft (with its verdict). claudeFn
 *     returns Claude's verdict on that same draft. Both logged together.
 *   - Round N>1: codexFn returns Codex's revision based on prevCritique (with
 *     its new verdict). claudeFn returns Claude's verdict on the revision.
 *   - Loop exits when both verdicts in the SAME round are SHIP.
 *
 * codexFn(round, prevCritique) → { reply: string }
 * claudeFn(round, codexVerdict) → { status, critique, rationale }
 */
export async function runRoundLoop({
  specPath,
  phase,
  codexFn,
  claudeFn,
  maxRounds = DEFAULT_MAX_ROUNDS,
}) {
  let prevCritique = [];
  for (let round = 1; round <= maxRounds; round++) {
    const codexResp = await codexFn(round, prevCritique);
    const codexVerdict = parseVerdict(codexResp.reply);
    const claudeVerdict = await claudeFn(round, codexVerdict);

    appendRound(specPath, {
      phase,
      round,
      claude: serialize(claudeVerdict),
      codex: serialize(codexVerdict),
    });

    if (codexVerdict.status === 'SHIP' && claudeVerdict.status === 'SHIP') {
      return { outcome: 'shipped', rounds: round, codex: codexVerdict, claude: claudeVerdict };
    }

    prevCritique = [
      ...codexVerdict.critique.map((c) => `[codex] ${c}`),
      ...claudeVerdict.critique.map((c) => `[claude] ${c}`),
    ];
  }
  return { outcome: 'deadlock', rounds: maxRounds };
}

function serialize(v) {
  if (v.status === 'SHIP') return 'SHIP';
  return `REVISE: ${v.critique.join('; ')}`;
}
