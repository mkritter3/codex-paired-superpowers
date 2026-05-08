import { appendRound } from './sidecar.js';
import { parseVerdict } from './verdict.js';

const DEFAULT_MAX_ROUNDS = 7;

/**
 * Run the Claude<->Codex round loop until both ship or maxRounds is hit.
 *
 * codexFn(round, prevCritique) → { reply: string }
 * claudeFn(round, codexVerdict) → { status, critique, rationale }
 */
export async function runRoundLoop({
  specPath,
  phase,
  initialArtifact,
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
