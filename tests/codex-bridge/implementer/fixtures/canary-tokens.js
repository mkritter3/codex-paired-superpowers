// v0.10.0 slice 10 — pinned canary constants for secret-redaction tests.
//
// These exact strings are the 4 canary tokens from spec L612-618.
// They must be kept in sync with CANARY_TOKENS in secret-redaction.js.

export const CANARY_TOKENS = {
  ollamaCloud: 'ollama-tok-test-canary-abc123',
  anthropicAuth: 'anthropic-auth-test-canary-def456',
  anthropicApi: 'sk-ant-canary-xyz789',
  openai: 'sk-openai-canary-uvw000',
};

export const ALL_CANARIES = Object.values(CANARY_TOKENS);

/**
 * Scan a string or buffer for any canary substring.
 * @param {string|Buffer} content
 * @returns {boolean}
 */
export function hasAnyCanary(content) {
  const s = typeof content === 'string' ? content : content.toString('utf8');
  return ALL_CANARIES.some((c) => s.includes(c));
}
