import { execFileSync } from 'node:child_process';

const MAX_ROUNDS = 7;

/**
 * The Commit Conventions string included in every fix-subagent prompt.
 * Per spec § "Commit Conventions".
 */
const COMMIT_CONVENTIONS = `Commit Conventions:
- Subject: fix(slice:<N>): live-verification fix - <scenario-id> <short name>
- Trailer: Co-Authored-By: Claude <noreply@anthropic.com>
- Allowed prefixes: feat, test, fix, docs, refactor, chore
- All commits MUST have the (slice:<N>): scope and the Co-Authored-By trailer.`;

/**
 * Subject regex: (feat|test|fix|docs|refactor|chore)(slice:<N>): ...
 */
const SUBJECT_RE = /^(feat|test|fix|docs|refactor|chore)\(slice:[^)]+\):/;

/**
 * Trailer regex: Co-Authored-By: Claude
 */
const CO_AUTHORED_BY_RE = /Co-Authored-By:\s*Claude/i;

/**
 * Pure function — packages scenario evidence into a structured failure context payload.
 *
 * @param {{ scenario, evidence_paths, slice_diff, git_status, test_output }} opts
 * @returns {{ scenario, evidence_paths, slice_diff, git_status, test_output }}
 */
export function packageFailureContext({ scenario, evidence_paths, slice_diff, git_status, test_output }) {
  return { scenario, evidence_paths, slice_diff, git_status, test_output };
}

/**
 * Walk git log from `lastCommitSha..HEAD` and verify every commit matches
 * the Commit Conventions (subject regex + Co-Authored-By trailer).
 *
 * @param {string} repoRoot
 * @param {string} lastCommitSha
 * @returns {{ ok: true, commits: string[] } | { ok: false, defect: string, sha: string }}
 */
function reconcileCommits(repoRoot, lastCommitSha) {
  let raw;
  try {
    raw = execFileSync(
      'git',
      ['log', `${lastCommitSha}..HEAD`, '--format=%H%n%s%n%b%n---END---'],
      { cwd: repoRoot, encoding: 'utf8' }
    );
  } catch {
    // If git log fails for any reason, treat as no new commits — ok
    return { ok: true, commits: [] };
  }

  const blocks = raw.split('---END---').map(b => b.trim()).filter(Boolean);
  if (blocks.length === 0) return { ok: true, commits: [] };

  const shas = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const sha = lines[0]?.trim();
    const subject = lines[1]?.trim() ?? '';
    const body = lines.slice(2).join('\n');

    if (!sha) continue;

    // Check subject convention
    if (!SUBJECT_RE.test(subject)) {
      return { ok: false, defect: 'subagent-broke-commit-conventions', sha };
    }

    // Check Co-Authored-By trailer
    if (!CO_AUTHORED_BY_RE.test(body)) {
      return { ok: false, defect: 'subagent-broke-commit-conventions', sha };
    }

    shas.push(sha);
  }

  return { ok: true, commits: shas };
}

/**
 * Build the failure context prompt for Codex diagnosis.
 *
 * @param {string} sliceId
 * @param {object} failure — packageFailureContext output
 * @returns {string}
 */
function buildCodexDiagnosisPrompt(sliceId, failure) {
  const { scenario, evidence_paths, slice_diff, git_status, test_output } = failure;
  return [
    `Live verification failure detected in ${sliceId}.`,
    ``,
    `Scenario: ${scenario.id} — ${scenario.title}`,
    ``,
    `Evidence paths:`,
    ...(evidence_paths || []).map(p => `  - ${p}`),
    ``,
    `Test output:`,
    test_output || '(none)',
    ``,
    `Git status:`,
    git_status || '(clean)',
    ``,
    `Slice diff:`,
    slice_diff || '(none)',
    ``,
    `Please diagnose the root cause of this failure and describe exactly what needs to be fixed.`,
  ].join('\n');
}

/**
 * Build the fix-subagent dispatch prompt.
 *
 * @param {string} sliceId
 * @param {string} diagnosisText
 * @param {object} failure
 * @returns {string}
 */
function buildSubagentPrompt(sliceId, diagnosisText, failure) {
  const { scenario } = failure;
  return [
    `You are a fix-subagent for ${sliceId} live-verification.`,
    ``,
    `A scenario has failed: ${scenario.id} — ${scenario.title}`,
    ``,
    `Codex diagnosis:`,
    diagnosisText,
    ``,
    `Your task: implement the minimal fix to make the failing scenario pass without breaking other scenarios.`,
    ``,
    COMMIT_CONVENTIONS,
    ``,
    `Apply the (slice:<N>): scope using the actual slice number from ${sliceId}.`,
    `Example: fix(slice:1): live-verification fix - ${scenario.id} ${scenario.title}`,
    ``,
    `After your fix, commit using the exact conventions above.`,
  ].join('\n');
}

/**
 * Factory: create a live-fix-loop orchestrator.
 *
 * @param {{
 *   codexCaller: (prompt: string) => Promise<{content: string}>,
 *   subagentDispatcher: ({prompt: string}) => Promise<{status: string, commits?: string[]}>,
 *   scenarioRunner: { runScenario: (sliceId: string, scenario: object) => Promise<{status: string}> },
 *   evidenceStore: object | null,
 *   sidecarOps: { appendLiveVerificationRound: Function, appendRound: Function },
 *   repoRoot: string,
 *   threadId: string,
 *   lastCommitSha: string,
 * }} opts
 * @returns {{ runFixLoop: Function }}
 */
export function createLiveFixLoop({
  codexCaller,
  subagentDispatcher,
  scenarioRunner,
  evidenceStore,
  sidecarOps,
  repoRoot,
  threadId,
  lastCommitSha,
}) {
  /**
   * Run the fix loop for a slice.
   *
   * @param {string} sliceId
   * @param {object[]} scenarios — all scenarios in the slice
   * @param {object[]} initialFailures — packageFailureContext payloads for failing scenarios
   * @returns {Promise<{outcome: string, rounds: object[], halt_reason?: string, sha?: string}>}
   */
  async function runFixLoop(sliceId, scenarios, initialFailures) {
    const rounds = [];
    let currentFailures = initialFailures;
    // Track the sha boundary for reconciliation — start from the provided lastCommitSha
    let reconcileFrom = lastCommitSha;

    for (let roundNum = 1; roundNum <= MAX_ROUNDS; roundNum++) {
      const roundRecord = { round: roundNum };

      // Step 1: Take the first failure to focus on (spec says fix-loop entry with failures)
      const failure = currentFailures[0];

      // Step 2: Build context and call Codex for diagnosis
      const ctx = packageFailureContext(failure);
      const diagnosisPrompt = buildCodexDiagnosisPrompt(sliceId, ctx);
      const diagnosisResult = await codexCaller(diagnosisPrompt);
      const diagnosisText = diagnosisResult.content;

      roundRecord.codex_diagnosis = diagnosisText;

      // Step 3: Append round to sidecar (best-effort; no specPath here, use sidecarOps)
      try {
        sidecarOps.appendLiveVerificationRound(roundRecord);
      } catch {
        // sidecarOps may be a no-op stub in tests
      }

      // Step 4: Dispatch fix-subagent with diagnosis + Commit Conventions
      const subagentPrompt = buildSubagentPrompt(sliceId, diagnosisText, failure);
      const subagentResult = await subagentDispatcher({ prompt: subagentPrompt });

      // Step 5: On BLOCKED → halt
      if (subagentResult.status === 'BLOCKED') {
        return {
          outcome: 'halt',
          halt_reason: 'live-verification-fix-subagent-blocked',
          rounds,
        };
      }

      // Step 6: Reconciliation — walk reconcileFrom..HEAD
      const reconciliation = reconcileCommits(repoRoot, reconcileFrom);
      if (!reconciliation.ok) {
        return {
          outcome: 'halt',
          halt_reason: reconciliation.defect,
          sha: reconciliation.sha,
          rounds,
        };
      }

      // Update reconcileFrom to current HEAD so next round only checks new commits
      try {
        const newHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
        reconcileFrom = newHead;
      } catch {
        // ignore; reconcileFrom stays as-is
      }

      // Step 7: Re-run ALL scenarios (not just failed)
      const newFailures = [];
      for (const scenario of scenarios) {
        const result = await scenarioRunner.runScenario(sliceId, scenario);
        if (result.status === 'failed') {
          newFailures.push({
            scenario,
            evidence_paths: result.evidence_paths ?? [],
            slice_diff: result.slice_diff ?? '',
            git_status: result.git_status ?? '',
            test_output: result.test_output ?? JSON.stringify(result),
          });
        }
      }

      roundRecord.scenarios_failed = newFailures.map(f => f.scenario.id);
      rounds.push(roundRecord);

      // Step 8: No failures → shipped
      if (newFailures.length === 0) {
        return { outcome: 'shipped', rounds };
      }

      // Step 9: Still failing → next round
      currentFailures = newFailures;
    }

    // Step 10: Exhausted 7 rounds without shipping → deadlock
    return {
      outcome: 'deadlock',
      halt_reason: 'live-verification-deadlock',
      rounds,
    };
  }

  return { runFixLoop };
}
