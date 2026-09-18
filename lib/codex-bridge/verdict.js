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
  const version = parseVersion(body);
  const critique = parseCritique(body);
  // v0.18.1: `deferred` carries findings the reviewer judged non-blocking. It must survive parsing
  // or the batched-cleanup rule in prompts/verdict-format.md would silently lose them.
  const deferred = parseListField(body, 'deferred');
  return { status, critique, rationale, deferred, version };
}

function parseVersion(body) {
  const match = body.match(/^[ \t]*version:[ \t]*(.*?)[ \t]*$/im);
  if (!match) return null;
  let value = match[1].trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      value = value.slice(1, -1).trim();
    }
  }
  return value || null;
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
    const l = lines[i];
    const bullet = l.match(/^\s*-\s+(.+)$/);
    if (bullet) {
      out.push(bullet[1].trim());
    } else if (/^\s*[a-z_]+:/i.test(l)) {
      // A new field ends the list. Anything else (a wrapped continuation line, a blank line) is
      // ignored rather than terminating: breaking on it truncated every finding after a wrapped
      // one, which is how most real findings are written.
      break;
    }
  }
  return out;
}

function synthetic(reason) {
  return { status: 'REVISE', critique: [reason], rationale: 'parser fallback', version: null };
}
