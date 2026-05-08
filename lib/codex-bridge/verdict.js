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
  return { status, critique, rationale };
}

function parseCritique(body) {
  if (/^\s*critique:\s*\[\s*\]\s*$/im.test(body)) return [];
  const lines = body.split('\n');
  const start = lines.findIndex((l) => /^\s*critique:\s*$/i.test(l));
  if (start === -1) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    const bullet = l.match(/^\s*-\s+(.+)$/);
    if (bullet) {
      out.push(bullet[1].trim());
    } else if (/^\s*[a-z_]+:/i.test(l)) {
      break;
    }
  }
  return out;
}

function synthetic(reason) {
  return { status: 'REVISE', critique: [reason], rationale: 'parser fallback' };
}
