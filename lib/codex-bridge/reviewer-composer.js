// Plan 3 (reviewer naming migration) — reviewer-composer: deterministic
// reviewer selection from phase + signals. Canonical home for the selection
// body that previously lived in role-composer.js (now a wrapper).
//
// Inputs:
//   - phase: one of 'spec-review' | 'pre-dispatch' | 'post-implementation-review'
//   - signals.specHas:           string[] — spec keywords / phrases
//   - signals.filePaths:         string[] — affected file paths
//   - signals.domains:           string[] — caller-supplied domain hints
//   - signals.reviewersDirective: string  — comma-separated roles from the
//                                           canonical **Reviewers:** directive
//   - signals.expertsDirective:  string   — comma-separated roles from the
//                                           deprecated **Experts:** directive
//                                           (alias; emits a directiveWarning)
//   - signals.explicitDirective: string   — legacy back-compat name for
//                                           expertsDirective
//   - signals.fanOutRationale:   string   — required when selected.length > 5
//   - repoRoot:                  string   — used by reviewer-resolver for overrides
//
// Output: { selected: ReviewerIdentity[], fanOutRationale: string|null,
//           selectionReasons: { [reviewerId]: string },
//           directiveWarning: string|null }
//
// Phase defaults always apply (architecture + test). Signals add domain
// reviewers. The explicit directive merges (never replaces) inferred selection.
// >5 selected without fanOutRationale throws role-composer-fan-out-unjustified
// (literal preserved — decision 6).

import { resolveIdentity, ReviewerResolverError } from './reviewer-resolver.js';

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

export function composeReviewers({ phase, signals = {}, repoRoot }) {
  const selectedRoles = new Set();
  const selectionReasons = {};

  // 1. Phase defaults (always apply)
  const defaults = PHASE_DEFAULTS[phase] || PHASE_DEFAULTS['spec-review'];
  for (const role of defaults) {
    selectedRoles.add(role);
    selectionReasons[`reviewer-${role}`] = `phase default for ${phase}`;
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
      if (!selectionReasons[`reviewer-${role}`]) {
        selectionReasons[`reviewer-${role}`] = `inferred from signals matching "${matched}"`;
      }
    }
  }

  // 3. Explicit directive merges (advisory, never replaces).
  //    `reviewersDirective` is canonical; `expertsDirective` is a deprecated
  //    alias (`explicitDirective` is a legacy back-compat name for the alias).
  //    If both canonical + alias are present, Reviewers wins and we record a
  //    precedence warning (spec §"New canonical plan directive", line 263).
  let directiveWarning = null;
  const reviewersDirective = signals.reviewersDirective;
  const expertsDirective = signals.expertsDirective ?? signals.explicitDirective;

  const mergeDirective = (raw, reason) => {
    const directiveRoles = raw
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
    for (const role of directiveRoles) {
      selectedRoles.add(role);
      if (!selectionReasons[`reviewer-${role}`]) {
        selectionReasons[`reviewer-${role}`] = reason;
      }
    }
  };

  if (reviewersDirective) {
    mergeDirective(reviewersDirective, 'from **Reviewers:** directive');
    if (expertsDirective) {
      directiveWarning =
        '**Reviewers:** takes precedence over deprecated **Experts:** directive';
    }
  } else if (expertsDirective) {
    mergeDirective(expertsDirective, 'from **Experts:** directive');
    directiveWarning =
      'the **Experts:** directive is deprecated; use **Reviewers:** instead';
  }

  // 4. Resolve identities; defensively filter out unresolvable roles
  const identities = [];
  for (const role of selectedRoles) {
    try {
      identities.push(resolveIdentity(role, repoRoot));
    } catch (err) {
      if (err instanceof ReviewerResolverError) {
        if (process.env.CPS_COMPOSER_DEBUG) {
          // eslint-disable-next-line no-console
          console.error(
            `[reviewer-composer] skipping unresolvable role "${role}": ${err.message}`
          );
        }
        delete selectionReasons[`reviewer-${role}`];
        continue;
      }
      throw err;
    }
  }

  // 5. Fan-out enforcement
  if (identities.length > 5) {
    if (!signals.fanOutRationale || !signals.fanOutRationale.trim()) {
      const err = new Error(
        `role-composer-fan-out-unjustified: selected ${identities.length} reviewers but no fanOutRationale provided in signals`
      );
      err.code = 'role-composer-fan-out-unjustified';
      throw err;
    }
  }

  return {
    selected: identities,
    fanOutRationale: identities.length > 5 ? signals.fanOutRationale : null,
    selectionReasons,
    directiveWarning,
  };
}
