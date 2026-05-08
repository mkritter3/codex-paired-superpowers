## Validation Rubric (REQUIRED for every slice)

Apply this rubric in two distinct modes:
- **Phase A (plan-slice + test-list review)**: enumerate subcategory-level coverage. Phase A is where the validation contract is *written*.
- **Phase C (slice review)**: verify the locked Phase A commitments. Phase C does NOT re-enumerate Tier-1 — it confirms each Phase A commitment was honored by the implementation.

Both Codex and Claude must follow this contract before SHIP.

### Acceptable validation methods

A category can be "covered" by any of:
- **Automated test**: a named test in the diff (e.g., `tests/foo.test.js::test_name`).
- **Existing test that exercises this**: a test already in the repo whose assertions cover this case.
- **Type-system / static check**: when the language's compiler / type checker rules out the failure mode (e.g., a non-nullable type in TypeScript rules out the null edge case).
- **Lint / format / structural check**: for docs, prompts, or config — e.g., "markdown link checker passes", "YAML lint passes".
- **Render / manual smoke**: for docs / prompts / pure-content slices — e.g., "rendered locally and visually inspected; before/after diff in PR description". Allowed when the slice has no executable code paths.

State which method covers each subcategory. "Covered" without naming the method is failure.

### N/A requires evidence

"N/A" alone is failure. Acceptable forms:
- **N/A because <slice-fact>, evidenced by <diff-fact>**: e.g., "N/A because slice doesn't take user input — `git diff --stat` shows only `lib/x.js`, no parser/handler/network code added."
- **N/A because <invariant>, enforced by <type or check>**: e.g., "N/A because the input is a non-nullable enum — TypeScript ruled out the null/undefined edge case at compile time."

A reviewer reading the verdict must be able to verify the N/A claim against the actual diff or repo state. Subjective N/As ("not applicable here") are failure.

### Tier 1 — Prescriptive baseline (every slice, every subcategory)

For each subcategory below, you must write one bullet in the verdict's `critique` array, even on SHIP. Subcategory-level coverage is mandatory; heading-level "Tier 1 covered" is failure.

**Happy path**
- The primary intended behavior, exercised end-to-end through the slice's public surface.
- For executable-code slices: required, no N/A. For docs / prompt-only slices: "N/A because slice has no executable surface" is acceptable IF evidence is provided.

**Edge cases — each subcategory below gets its own bullet:**
- **edge.zero-null-empty**: empty input, null/optional, zero-length collection.
- **edge.boundary**: min, max, off-by-one (n, n−1, n+1 around any limit).
- **edge.large-input**: input significantly larger than typical (10×, 100×) — required when Tier-2 stress triggers fire (see below).
- **edge.concurrent**: if the slice touches shared state, two writers / reader-during-write / interrupt-during-write.
- **edge.adversarial**: malformed, oversized, deliberately crafted to break (path traversal, injection, encoding tricks). Required when slice ingests external/user input.

**Failure modes — each subcategory below gets its own bullet:**
- **fail.dependency**: if the slice calls network / disk / MCP / subprocess, what happens when it fails / times out / returns garbage?
- **fail.malformed-input**: invalid JSON, missing required field, wrong type. The code should fail loudly, not silently default.
- **fail.exception-path**: if the code throws, who catches it? Is the failure visible to the right consumer?

**Multi-module integration**
- **integration.cross-module**: if the slice's diff touches > 1 module (separate file/class/exported function with its own contract), an integration test exercises the public surface across the boundary.

### Tier 2 — Conditional triggers (state the trigger explicitly)

These categories activate based on slice characteristics. For each, state whether the trigger fires.

**Stress** (`stress.scale`)
- **Triggers** (any of):
  - The slice introduces or modifies a parser, serializer, or formatter.
  - The slice contains recursion or unbounded loops over user/project data.
  - The slice traverses the filesystem or processes diffs / test output / large strings.
  - The slice introduces a data structure that grows with input (lists, trees, graphs, accumulating buffers).
  - The slice contains nested loops over collections (O(n²) risk).
- **Required when triggered**: a test exercising 10× or 100× the typical input, asserting the operation completes within a reasonable bound (no OOM, no quadratic blow-up).

**Performance assertion** (`perf.slo`)
- **Trigger**: the spec stated a latency / throughput / resource SLO.
- **Required when triggered**: a test asserting the SLO holds.

**Compatibility** (`compat.breaking`)
- **Trigger**: the slice changes a public API, on-disk format, wire protocol, or sidecar/state schema.
- **Required when triggered**: either a test verifying old consumers / old data still work, OR an explicit "this is a breaking change" call-out in the spec/plan.

### Validation tiers — what each one operationally requires

The slice's plan frontmatter declares `validation: light`, `standard` (default), or `critical`. The tier changes Tier-1 strictness:

- **light**: only `happy` is required. All other Tier-1 subcategories may be marked `N/A because validation tier is light` PLUS evidence that the slice is genuinely trivial (small diff, no executable surface, no external input, etc.). If the diff doesn't look trivial, REVISE and ask for the tier to be raised.
- **standard** (default): all Tier-1 subcategories must have entries (covered or evidence-backed N/A). Tier-2 triggers checked normally.
- **critical**: standard + Tier 3 below.

Phase A's verdict critique must explicitly state which tier is in effect (e.g., `tier: critical`).

### Tier 3 — Critical residual-risk question (only when `validation: critical`)

In addition to Tier 1+2, answer:

> "What would a paranoid senior engineer test that we haven't?"

Answer with a concrete test case, failure scenario, attack vector, or interaction with another part of the system that could break. Generic answers ("more edge cases", "thorough testing") are failure. If you genuinely cannot find anything, state explicitly that the slice is fully covered by Tier 1+2 and explain why no residual risk remains.

This question is OPERATIONAL, not theatrical: the answer either becomes another test (added to the slice) or is recorded under `## Deferred` if it's out of scope for this slice but warrants a future ticket.

The verdict's critique must include a `critical.residual-risk:` bullet capturing the answer (one of: a concrete test case to add, a deferred risk, or "no residual risk because <specific reason>"). Without this keyed bullet, Phase C cannot verify the residual-risk question was honored.

### Output format in plan-slice review (Phase A) verdict

The `critique` field must include, in order:

1. A `tier:` metadata bullet declaring the validation tier in effect.
2. One bullet per Tier-1 subcategory (always, with the keys below).
3. One bullet per Tier-2 category (always, fired-or-not).
4. If `tier: critical`, one `critical.residual-risk:` bullet.

Each bullet starts with the subcategory key followed by `:` and the coverage statement. The orchestrator parses these keys; any missing required key OR any unknown / duplicate / malformed key causes the orchestrator to halt with `validation-coverage-malformed`.

Required Tier-1 keys: `happy`, `edge.zero-null-empty`, `edge.boundary`, `edge.large-input`, `edge.concurrent`, `edge.adversarial`, `fail.dependency`, `fail.malformed-input`, `fail.exception-path`, `integration.cross-module`.

Required Tier-2 keys: `stress.scale`, `perf.slo`, `compat.breaking`.

```
critique:
  - tier: standard
  - happy: covered by tests/foo.test.js::test_basic
  - edge.zero-null-empty: covered by tests/foo.test.js::test_empty_input
  - edge.boundary: covered by tests/foo.test.js::test_boundary
  - edge.large-input: N/A because stress.scale not triggered (slice is constant-time, evidenced by no loops in the diff)
  - edge.concurrent: N/A because slice has no shared state, evidenced by `git diff --stat` showing only pure functions
  - edge.adversarial: N/A because slice doesn't ingest external input, evidenced by no parser/handler in the diff
  - fail.dependency: N/A because slice has no external calls, evidenced by no fs/net/spawn in the diff
  - fail.malformed-input: covered by tests/foo.test.js::test_malformed
  - fail.exception-path: covered by tests/foo.test.js::test_throws
  - integration.cross-module: N/A because slice touches one module only (lib/foo.js)
  - stress.scale: not triggered (no scaling structure)
  - perf.slo: not triggered (no SLO in spec)
  - compat.breaking: not triggered (no public API change)
```

If you're emitting `status: SHIP`, every Tier-1 subcategory must have an entry AND every Tier-2 trigger must be explicitly stated as fired-or-not. Missing entries = automatic REVISE.

### Output format in slice review (Phase C) verdict

In Phase C the implementation is in hand. Phase A's coverage was locked when Phase A double-SHIP'd; Phase C does NOT re-enumerate Tier-1 subcategories. Phase C verifies that the implementation honored the validation commitments Phase A made. The `critique` field must include exactly these four bullets:

- **rubric.diff-vs-plan**: for each validation commitment Phase A made (whether it was a test, a type check, a lint check, or a manual smoke), confirm the diff actually delivered it. Cite the specific artifact (test name, type signature, lint config, smoke evidence). If a Phase A commitment is missing in the diff, that's a REVISE.
- **rubric.test-results**: did the tests run and pass? (cite the test output supplied in the prompt). If Phase A used non-test methods exclusively, state "no tests promised; <method> evidence: ...".
- **rubric.uncovered-paths**: are there code paths in the diff that no Phase-A-committed validation covers? (cite specific lines or note "all paths covered by Phase A's commitments")
- **rubric.new-triggers**: did the implementation introduce surface that triggers Tier-2 categories Phase A didn't account for? (e.g., the implementer added a recursion that fires `stress.scale` but Phase A marked stress as not-triggered). If found, this is a REVISE — Phase A needs to be re-opened to add coverage, OR a follow-up slice committed.

### Why this exists

L11-grade engineering means the failure boundaries are tested, not the happy path. Subcategory-level enumeration prevents "all good" SHIPs that hide unexamined risks. Evidence-backed N/As prevent the rubric from becoming a paperwork exercise. The diff/repo must support every claim made in the verdict.
