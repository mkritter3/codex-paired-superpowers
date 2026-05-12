// v0.9.0 slice 1 — DispatchResult shape enforcement.
//
// Every adapter eventually returns a normalized DispatchResult:
//
//   {
//     responseText: string,
//     exit: number,
//     warnings: string[],
//     sessionId: string | null,
//     adapterMeta: object,
//     duration_ms: number,
//   }
//
// Missing fields default sanely. Extra fields the adapter included are
// preserved by merging them into `adapterMeta` (so we never silently
// drop information that could help debug a misbehaving CLI).

const CANONICAL_KEYS = new Set([
  'responseText',
  'exit',
  'warnings',
  'sessionId',
  'adapterMeta',
  'duration_ms',
]);

export function normalizeDispatchResult(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};

  const responseText = typeof r.responseText === 'string' ? r.responseText : '';
  const exit = Number.isFinite(r.exit) ? r.exit : 0;
  const warnings = Array.isArray(r.warnings) ? [...r.warnings] : [];
  const sessionId =
    typeof r.sessionId === 'string' || r.sessionId === null
      ? r.sessionId
      : null;
  const baseMeta = r.adapterMeta && typeof r.adapterMeta === 'object'
    ? { ...r.adapterMeta }
    : {};
  const duration_ms = Number.isFinite(r.duration_ms) ? r.duration_ms : 0;

  // Preserve any extras the adapter set as top-level keys under adapterMeta.
  for (const k of Object.keys(r)) {
    if (CANONICAL_KEYS.has(k)) continue;
    if (!(k in baseMeta)) baseMeta[k] = r[k];
  }

  return {
    responseText,
    exit,
    warnings,
    sessionId,
    adapterMeta: baseMeta,
    duration_ms,
  };
}
