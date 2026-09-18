const BLOCK_RX = /<<<VERDICT>>>([\s\S]*?)<<<END>>>/;

export function parseVerdict(text) {
  const m = text.match(BLOCK_RX);
  if (!m) {
    return synthetic('verdict block missing or malformed; please re-emit');
  }
  const body = m[1];
  const status = (body.match(/^\s*status:\s*(SHIP|REVISE)\s*$/im) || [])[1];
  if (!status) {
    return synthetic('malformed verdict: status must be SHIP or REVISE');
  }
  const rationale = (body.match(/^\s*rationale:\s*(.+)$/im) || [, ''])[1].trim();
  const critique = parseCritique(body);
  // v0.18.1: `deferred` carries findings the reviewer judged non-blocking. It must survive parsing
  // or the batched-cleanup rule in prompts/verdict-format.md would silently lose them.
  const deferred = parseListField(body, 'deferred');
  return { status, critique, rationale, deferred };
}

function parseCritique(body) {
  return parseListField(body, 'critique');
}

/**
 * Read a `<name>:` block of `- item` bullets from a verdict body.
 * Accepts the inline empty form (`<name>: []`) and returns [] when the field is absent.
 */
function parseListField(body, name) {
  const inlineEmpty = new RegExp(`^\\s*${name}:\\s*\\[\\s*\\]\\s*$`, 'im');
  if (inlineEmpty.test(body)) return [];
  const lines = body.split('\n');
  const header = new RegExp(`^\\s*${name}:\\s*$`, 'i');
  const start = lines.findIndex((l) => header.test(l));
  if (start === -1) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    const bullet = line.match(/^\s*-\s+(.*)$/);
    if (bullet) { out.push(bullet[1].trim()); continue; }
    if (/^\s*$/.test(line)) continue;
    break;
  }
  return out;
}

function synthetic(reason) {
  return { status: 'REVISE', critique: [reason], rationale: 'parser fallback' };
}
