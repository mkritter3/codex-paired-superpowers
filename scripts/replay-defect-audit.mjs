#!/usr/bin/env node
// Replay defect audit — counts the v0.13.0 defect signatures in real session transcripts, so we can
// measure before/after instead of only "the mechanism works".
//
// Methodology (mirrors the v0.13.0 spec §1): parse JSONL transcripts structurally, match each defect
// signature in tool_RESULT content (not in prose discussing bugs), and detect runs of identical
// failing Edit calls. Pass transcript paths as args; prints per-file + total counts as JSON.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const SIGNATURES = {
  thread_loss:      /Session not found for thread_id/,
  audit_gate_error: /Honest-reporting audit gate|Missing audit evidence|refusing to log SHIP verdict/,
  file_not_read:    /File has not been read yet/,
  string_not_found: /String to replace not found/,
  // stale model id reaching the API (the 400)
  model_400:        /gpt-5\.2(?:-codex)?[^]{0,80}?(?:not supported|invalid_request)/i,
  // sandbox could not execute real verification (read-only / port / cache write blocked)
  sandbox_exec:     /did not rerun|read-only (?:review|filesystem|sandbox)|still has a read-only|EPERM|cannot write to[^]{0,40}cache|emulator (?:ports?|in this sandbox)/i,
};

function blockText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (typeof b === 'string' ? b : (b && (b.text || b.content)) || '')).join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

function auditFile(path) {
  const counts = Object.fromEntries(Object.keys(SIGNATURES).map((k) => [k, 0]));
  const toolUses = new Map(); // tool_use_id -> { name, input }
  // For identical-failing-edit runs:
  let editRuns = 0; // runs of >= 3 identical failing edits
  let maxRun = 0;
  let curHash = null;
  let curRun = 0;

  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const content = obj.message && obj.message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type === 'tool_use') {
        toolUses.set(b.id, { name: b.name, input: b.input });
      } else if (b.type === 'tool_result') {
        const text = blockText(b.content);
        for (const [k, re] of Object.entries(SIGNATURES)) {
          if (re.test(text)) counts[k] += 1;
        }
        // identical-failing-edit run detection
        const tu = toolUses.get(b.tool_use_id);
        const isEditFail = tu && tu.name === 'Edit' && b.is_error === true;
        if (isEditFail) {
          const h = createHash('sha1')
            .update(JSON.stringify([tu.input?.file_path, tu.input?.old_string, tu.input?.new_string]))
            .digest('hex');
          if (h === curHash) {
            curRun += 1;
          } else {
            if (curRun >= 3) editRuns += 1;
            curHash = h; curRun = 1;
          }
          maxRun = Math.max(maxRun, curRun);
        } else {
          if (curRun >= 3) editRuns += 1;
          curHash = null; curRun = 0;
        }
      }
    }
  }
  if (curRun >= 3) editRuns += 1;
  return { ...counts, identical_edit_runs_ge3: editRuns, max_identical_edit_run: maxRun, lines: lines.length };
}

const files = process.argv.slice(2);
if (files.length === 0) {
  process.stderr.write('usage: replay-defect-audit.mjs <transcript.jsonl> [...]\n');
  process.exit(2);
}
const per = {};
const total = {};
for (const f of files) {
  const r = auditFile(f);
  const short = f.split('/').slice(-2).join('/');
  per[short] = r;
  for (const [k, v] of Object.entries(r)) {
    if (k === 'max_identical_edit_run') total[k] = Math.max(total[k] || 0, v);
    else total[k] = (total[k] || 0) + v;
  }
}
process.stdout.write(JSON.stringify({ per_transcript: per, total }, null, 2) + '\n');
