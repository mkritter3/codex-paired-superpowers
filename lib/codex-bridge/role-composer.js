// v0.8.0 role-composer — deterministic expert selection from phase + signals.
//
// Inputs:
//   - phase: one of 'spec-review' | 'pre-dispatch' | 'post-implementation-review'
//   - signals.specHas:           string[] — spec keywords / phrases
//   - signals.filePaths:         string[] — affected file paths
//   - signals.domains:           string[] — caller-supplied domain hints
//   - signals.explicitDirective: string   — comma-separated roles from a
//                                           **Experts:** spec directive
//   - signals.fanOutRationale:   string   — required when selected.length > 5
//   - repoRoot:                  string   — used by expert-resolver for overrides
//
// Output: { selected: ExpertIdentity[], fanOutRationale: string|null,
//           selectionReasons: { [expertId]: string } }
//
// Phase defaults always apply (architecture + test). Signals add domain
// experts. The explicit directive merges (never replaces) inferred selection.
// >5 selected without fanOutRationale throws role-composer-fan-out-unjustified.

import { resolveIdentity, ExpertResolverError } from './expert-resolver.js';

const PHASE_DEFAULTS = {
  'spec-review': ['architecture', 'test'],
  'pre-dispatch': ['architecture', 'test'],
  'post-implementation-review': ['architecture', 'test'],
};

const SIGNAL_ROLES = [
  {
    roles: ['ui', 'ux'],
    keywords: ['ui', 'visual', 'editor', 'panel', 'render', 'component'],
  },
  {
    roles: ['ai-harness'],
    keywords: ['model', 'prompt', 'mcp', 'agent', 'codex', 'provider'],
  },
  {
    roles: ['security'],
    keywords: ['credential', 'token', 'auth', 'permission', 'sandbox', 'secret'],
  },
  {
    roles: ['backend'],
    keywords: ['api', 'database', 'migration', 'query', 'persistence'],
  },
];

export function composeExperts({ phase, signals = {}, repoRoot }) {
  const selectedRoles = new Set();
  const selectionReasons = {};

  // 1. Phase defaults (always apply)
  const defaults = PHASE_DEFAULTS[phase] || PHASE_DEFAULTS['spec-review'];
  for (const role of defaults) {
    selectedRoles.add(role);
    selectionReasons[`expert-${role}`] = `phase default for ${phase}`;
  }

  // 2. Signal-based inference
  const haystack = [
    ...(signals.specHas || []),
    ...(signals.filePaths || []),
    ...(signals.domains || []),
  ]
    .join(' ')
    .toLowerCase();

  for (const { roles, keywords } of SIGNAL_ROLES) {
    const matched = keywords.find((kw) => haystack.includes(kw));
    if (!matched) continue;
    for (const role of roles) {
      selectedRoles.add(role);
      if (!selectionReasons[`expert-${role}`]) {
        selectionReasons[`expert-${role}`] = `inferred from signals matching "${matched}"`;
      }
    }
  }

  // 3. Explicit **Experts:** directive merges (advisory, never replaces)
  if (signals.explicitDirective) {
    const directiveRoles = signals.explicitDirective
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
    for (const role of directiveRoles) {
      selectedRoles.add(role);
      if (!selectionReasons[`expert-${role}`]) {
        selectionReasons[`expert-${role}`] = `from **Experts:** directive`;
      }
    }
  }

  // 4. Resolve identities; defensively filter out unresolvable roles
  const identities = [];
  for (const role of selectedRoles) {
    try {
      identities.push(resolveIdentity(role, repoRoot));
    } catch (err) {
      if (err instanceof ExpertResolverError) {
        if (process.env.CPS_COMPOSER_DEBUG) {
          // eslint-disable-next-line no-console
          console.error(
            `[role-composer] skipping unresolvable role "${role}": ${err.message}`
          );
        }
        delete selectionReasons[`expert-${role}`];
        continue;
      }
      throw err;
    }
  }

  // 5. Fan-out enforcement
  if (identities.length > 5) {
    if (!signals.fanOutRationale || !signals.fanOutRationale.trim()) {
      const err = new Error(
        `role-composer-fan-out-unjustified: selected ${identities.length} experts but no fanOutRationale provided in signals`
      );
      err.code = 'role-composer-fan-out-unjustified';
      throw err;
    }
  }

  return {
    selected: identities,
    fanOutRationale: identities.length > 5 ? signals.fanOutRationale : null,
    selectionReasons,
  };
}
