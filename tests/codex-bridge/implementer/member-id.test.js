// Tests for lib/codex-bridge/implementer/member-id.js (v0.10.0 slice 1).
// Validation tier: standard.
// All assertions are result-oriented (return values, thrown errors).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMemberId,
  formatMemberId,
  memberIdSlug,
} from '../../../lib/codex-bridge/implementer/member-id.js';

// ── parseMemberId ─────────────────────────────────────────────────────────────

test('parseMemberId: parses claude member ID with model containing colon', () => {
  const result = parseMemberId('expert-implementer@claude:kimi-k2.6:cloud#0');
  assert.deepEqual(result, {
    roleId: 'expert-implementer',
    cliKind: 'claude',
    modelId: 'kimi-k2.6:cloud',
    ordinal: 0,
  });
});

test('parseMemberId: parses codex member ID with simple model (no colon)', () => {
  const result = parseMemberId('expert-implementer@codex:gpt-5.5#0');
  assert.deepEqual(result, {
    roleId: 'expert-implementer',
    cliKind: 'codex',
    modelId: 'gpt-5.5',
    ordinal: 0,
  });
});

test('parseMemberId: parses non-zero ordinal', () => {
  const result = parseMemberId('expert-implementer@claude:kimi-k2.6:cloud#2');
  assert.equal(result.ordinal, 2);
});

test('parseMemberId: parses model with multiple colons', () => {
  // model_id is opaque; additional colons in model_id are allowed
  const result = parseMemberId('expert-implementer@claude:glm-4.7:cloud#0');
  assert.equal(result.modelId, 'glm-4.7:cloud');
  assert.equal(result.cliKind, 'claude');
});

test('parseMemberId: rejects empty string input', () => {
  assert.throws(
    () => parseMemberId(''),
    (err) => {
      assert.ok(err instanceof Error);
      return true;
    }
  );
});

test('parseMemberId: rejects non-string input', () => {
  assert.throws(() => parseMemberId(null));
  assert.throws(() => parseMemberId(42));
  assert.throws(() => parseMemberId(undefined));
});

test('parseMemberId: rejects empty roleId', () => {
  // No characters before '@'
  assert.throws(
    () => parseMemberId('@claude:kimi-k2.6:cloud#0'),
    (err) => {
      assert.ok(err.message.includes('roleId') || err.message.includes('empty'));
      return true;
    }
  );
});

test('parseMemberId: rejects non-integer ordinal (float string)', () => {
  assert.throws(
    () => parseMemberId('expert-implementer@claude:kimi-k2.6:cloud#1.5'),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes('ordinal') || err.message.includes('integer'),
        `Expected ordinal/integer in error message, got: ${err.message}`
      );
      return true;
    }
  );
});

test('parseMemberId: rejects non-integer ordinal (text string)', () => {
  assert.throws(
    () => parseMemberId('expert-implementer@claude:kimi-k2.6:cloud#abc'),
    (err) => {
      assert.ok(err instanceof Error);
      return true;
    }
  );
});

test('parseMemberId: rejects unknown cliKind (gemini)', () => {
  assert.throws(
    () => parseMemberId('expert-implementer@gemini:some-model#0'),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes('gemini') || err.message.includes('cliKind') || err.message.includes('unknown'),
        `Expected cliKind/unknown in error message, got: ${err.message}`
      );
      return true;
    }
  );
});

test('parseMemberId: rejects empty cliKind', () => {
  // e.g. 'expert-implementer@:model#0' — colon immediately after @
  assert.throws(
    () => parseMemberId('expert-implementer@:kimi-k2.6:cloud#0'),
    (err) => {
      assert.ok(err instanceof Error);
      return true;
    }
  );
});

test('parseMemberId: rejects empty modelId', () => {
  // e.g. 'expert-implementer@claude:#0' — nothing after cli: before #
  assert.throws(
    () => parseMemberId('expert-implementer@claude:#0'),
    (err) => {
      assert.ok(err instanceof Error);
      return true;
    }
  );
});

test('parseMemberId: rejects missing # separator', () => {
  assert.throws(
    () => parseMemberId('expert-implementer@claude:kimi-k2.6:cloud'),
    (err) => {
      assert.ok(err instanceof Error);
      return true;
    }
  );
});

// ── formatMemberId ────────────────────────────────────────────────────────────

test('formatMemberId: round-trips parseMemberId for claude model with colon', () => {
  const original = 'expert-implementer@claude:kimi-k2.6:cloud#0';
  const parsed = parseMemberId(original);
  const formatted = formatMemberId(parsed);
  assert.equal(formatted, original);
});

test('formatMemberId: round-trips parseMemberId for codex model', () => {
  const original = 'expert-implementer@codex:gpt-5.5#0';
  const parsed = parseMemberId(original);
  const formatted = formatMemberId(parsed);
  assert.equal(formatted, original);
});

test('formatMemberId: round-trips with non-zero ordinal', () => {
  const original = 'expert-implementer@claude:kimi-k2.6:cloud#2';
  const parsed = parseMemberId(original);
  const formatted = formatMemberId(parsed);
  assert.equal(formatted, original);
});

test('formatMemberId: rejects empty roleId', () => {
  assert.throws(() =>
    formatMemberId({ roleId: '', cliKind: 'claude', modelId: 'model', ordinal: 0 })
  );
});

test('formatMemberId: rejects unknown cliKind', () => {
  assert.throws(() =>
    formatMemberId({ roleId: 'r', cliKind: 'gemini', modelId: 'model', ordinal: 0 })
  );
});

test('formatMemberId: rejects empty modelId', () => {
  assert.throws(() =>
    formatMemberId({ roleId: 'r', cliKind: 'claude', modelId: '', ordinal: 0 })
  );
});

test('formatMemberId: rejects non-integer ordinal', () => {
  assert.throws(() =>
    formatMemberId({ roleId: 'r', cliKind: 'claude', modelId: 'm', ordinal: 1.5 })
  );
});

// ── memberIdSlug ──────────────────────────────────────────────────────────────

test('memberIdSlug: output contains only [a-z0-9-] characters', () => {
  const slug = memberIdSlug('expert-implementer@claude:kimi-k2.6:cloud#0');
  assert.match(slug, /^[a-z0-9-]+$/);
});

test('memberIdSlug: is deterministic for same input', () => {
  const memberId = 'expert-implementer@claude:kimi-k2.6:cloud#0';
  const slug1 = memberIdSlug(memberId);
  const slug2 = memberIdSlug(memberId);
  assert.equal(slug1, slug2);
});

test('memberIdSlug: different inputs produce different slugs', () => {
  const slug1 = memberIdSlug('expert-implementer@claude:kimi-k2.6:cloud#0');
  const slug2 = memberIdSlug('expert-implementer@claude:kimi-k2.6:cloud#1');
  assert.notEqual(slug1, slug2);
});

test('memberIdSlug: ends with an 8-character hex hash suffix', () => {
  const slug = memberIdSlug('expert-implementer@codex:gpt-5.5#0');
  // The slug is `<prefix>-<8hex>`. The last 8 chars before end should be hex.
  const parts = slug.split('-');
  const hashPart = parts[parts.length - 1];
  assert.equal(hashPart.length, 8, 'hash suffix must be exactly 8 characters');
  assert.match(hashPart, /^[0-9a-f]+$/, 'hash suffix must be lowercase hex');
});

test('memberIdSlug: rejects empty input', () => {
  assert.throws(() => memberIdSlug(''));
});

test('memberIdSlug: same model, different ordinals → different slugs', () => {
  const s0 = memberIdSlug('expert-implementer@claude:kimi-k2.6:cloud#0');
  const s1 = memberIdSlug('expert-implementer@claude:kimi-k2.6:cloud#1');
  const s2 = memberIdSlug('expert-implementer@claude:kimi-k2.6:cloud#2');
  assert.notEqual(s0, s1);
  assert.notEqual(s1, s2);
  assert.notEqual(s0, s2);
});
