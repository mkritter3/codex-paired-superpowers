// v0.8.0 expert-output-parser — strict JSON-block parser for expert turn output.
//
// Expert turns return free-form Markdown that MUST contain one fenced JSON
// block inside a `## Machine Result` section. The Markdown around that block
// is lenient; the JSON is strict.
//
// API:
//   parseExpertOutput(rawText, { expectedExpertId, expectedPhase })
//     -> { ok: true,  result: <parsed>, warnings?: string[] }
//     -> { ok: false, reason: <code>, ...details }
//
//   buildRepairPrompt({ rawOutput, reason, expectedExpertId, expectedPhase })
//     -> string  (one-shot repair instruction for the expert)

const REQUIRED_FIELDS = [
  'expert_id',
  'phase',
  'status',
  'scope',
  'blocking_findings',
  'nonblocking_findings',
  'peer_messages_sent',
  'questions_for_orchestrator',
];

const ARRAY_FIELDS = [
  'blocking_findings',
  'nonblocking_findings',
  'peer_messages_sent',
  'questions_for_orchestrator',
];

const VALID_STATUSES = new Set(['SHIP', 'REVISE']);

// Extract `## Machine Result` blocks. Regex matches the heading + the next
// fenced ```json block immediately following (allowing blank lines between
// heading and fence).
// Returns array of { rawBlock, startIndex }.
function extractMachineBlocks(rawText) {
  const re = /^##\s+Machine\s+Result\s*\n+```json\s*\n([\s\S]*?)\n```/gm;
  const blocks = [];
  let m;
  while ((m = re.exec(rawText)) !== null) {
    blocks.push({ rawBlock: m[1], startIndex: m.index });
  }
  return blocks;
}

export function parseExpertOutput(rawText, opts = {}) {
  const { expectedExpertId, expectedPhase } = opts;

  const blocks = extractMachineBlocks(rawText);
  if (blocks.length === 0) {
    return { ok: false, reason: 'missing-machine-block' };
  }

  // First block wins.
  const { rawBlock } = blocks[0];

  let parsed;
  try {
    parsed = JSON.parse(rawBlock);
  } catch (err) {
    return {
      ok: false,
      reason: 'invalid-json',
      rawBlock,
      parseError: err.message,
    };
  }

  // Object-shape guard: JSON.parse accepts primitives (null, 42, "str", true)
  // and arrays. Those would make the `f in parsed` schema loop throw a
  // TypeError ("Cannot use 'in' operator to search for ... in <primitive>"),
  // escaping the parser instead of returning schema-violation. Catch them
  // here and route to the same one-shot-repair path as missing fields.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      reason: 'schema-violation',
      missingFields: REQUIRED_FIELDS.slice(),
      rawBlock,
      detail: `expected JSON object; got ${parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed}`,
    };
  }

  // Schema check: required fields present + array fields actually arrays.
  // A field counts as a schema violation if it is absent OR if it is present
  // but the wrong type (currently only the array fields are type-checked).
  const missingFields = [];
  for (const f of REQUIRED_FIELDS) {
    if (!(f in parsed)) {
      missingFields.push(f);
    }
  }
  for (const f of ARRAY_FIELDS) {
    if (f in parsed && !Array.isArray(parsed[f])) {
      if (!missingFields.includes(f)) {
        missingFields.push(f);
      }
    }
  }
  if (missingFields.length > 0) {
    return { ok: false, reason: 'schema-violation', missingFields };
  }

  // Identity / phase / status checks (after schema is structurally valid).
  if (
    expectedExpertId !== undefined &&
    parsed.expert_id !== expectedExpertId
  ) {
    return {
      ok: false,
      reason: 'expert-id-mismatch',
      got: parsed.expert_id,
      expected: expectedExpertId,
    };
  }
  if (expectedPhase !== undefined && parsed.phase !== expectedPhase) {
    return {
      ok: false,
      reason: 'phase-mismatch',
      got: parsed.phase,
      expected: expectedPhase,
    };
  }
  if (!VALID_STATUSES.has(parsed.status)) {
    return { ok: false, reason: 'invalid-status', got: parsed.status };
  }

  const result = { ok: true, result: parsed };
  if (blocks.length > 1) {
    result.warnings = ['multiple-machine-blocks'];
  }
  return result;
}

export function buildRepairPrompt({
  rawOutput,
  reason,
  expectedExpertId,
  expectedPhase,
}) {
  return [
    `Your previous response did not produce a parseable Machine Result block.`,
    `Failure reason: ${reason}.`,
    ``,
    `Re-emit your response. Surrounding Markdown can be free-form (e.g., a "## Findings" section is fine).`,
    `But you MUST include exactly ONE \`## Machine Result\` section containing one fenced \`\`\`json ... \`\`\` block with these required fields:`,
    `  - expert_id (must be "${expectedExpertId}")`,
    `  - phase (must be "${expectedPhase}")`,
    `  - status ("SHIP" or "REVISE")`,
    `  - scope (string)`,
    `  - blocking_findings (array, can be empty)`,
    `  - nonblocking_findings (array, can be empty)`,
    `  - peer_messages_sent (array, can be empty)`,
    `  - questions_for_orchestrator (array, can be empty)`,
    ``,
    `For reference, here is your previous output verbatim:`,
    ``,
    `--- BEGIN PREVIOUS OUTPUT ---`,
    rawOutput,
    `--- END PREVIOUS OUTPUT ---`,
  ].join('\n');
}
