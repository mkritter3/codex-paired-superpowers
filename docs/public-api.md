# Public API contract

This document names the supported user-facing surface of codex-paired-superpowers. The prose explains intent; the seven JSON blocks are the machine-readable source of truth. Each item records its stability and first contract release.

## Skills

The stable slash commands are derived from command filenames and their argument hints. Their inputs are the names in the delegated skill body's input section.

## Bridge CLI

Every runtime verb is inventoried below. Cases are executable coverage records, and every flag is exercised by at least one successful case whose invocation actually includes `--flag` or `--flag=value` when the flag has a success path. Flag contracts describe the permissive parser; individual handlers enforce required values. A JSON case names a recursive shape in `stdout_types`; `field_values` pins semantically significant values within that shape. Primitive arrays use `string[]` (or another primitive element type); record arrays use `{ "type": "object[]", "items": <shape> }`. A plain object shape maps required field names to their nested types and rejects additional fields. Where fields are optional or a record is nullable, the long form is `{ "type": "object" | "object|null", "required": { ... }, "optional": { ... }, "additional": false }`; `additional` defaults to `false`. Unions use `|`. Text cases declare either an exact value or a regular expression. Any verb with non-empty `unsupported` extraction markers must carry a manual entry with a reason and handler-region digest; a digest may also document a known defensive path that executable fixtures cannot induce. Honest-reporting markers remain readable after expiry: `honest-reporting-is-active` reports `active: true, reason: "active"` for a future expiry, `active: false, reason: "expired"` for an elapsed expiry while retaining the marker object, and `marker-absent-or-malformed` with a null marker when none can be read.

An expansion may name `call`, the normalized source text of one non-literal load expression. When present it exempts only that operation at `site`; another unresolved load in the same file remains an error. The registry expansion below deliberately binds to its single computed adapter import.

## Execution wrapper

The wrapper publishes an atomic started record before launch and replaces it with an exited record after completion. Child exit codes pass through unless the wrapper reports its own documented usage, persistence, configuration, or signal outcome.

## Doctor

JSON consumers may rely on the envelope and check names. Human consumers may rely on one status-prefixed line per check and the exit rule, not sentence wording.

## Project configuration

The schema describes the loader's accepted JSON shape. `version` is intentionally permissive: every non-null JSON value is accepted because the loader checks only presence. For non-library apps, `live_verification.default` is likewise unconstrained and may be numeric or otherwise non-string. Scheduled-window times preserve the loader's existing JavaScript coercion: `String(value)` is tested against `HH:MM`, so a single-element array — nested to any depth — is accepted when it stringifies to a valid time (`[["09:00"]]`), while a multi-element array stringifies with a comma and is rejected; the schema expresses this with the recursive `$defs.window_time`. Worktree symlink strings preserve the loader's prefix and slash-segment checks exactly, including embedded newlines and the permissive trailing-newline `"..\n"` case. Runtime cases separately pin those permissive branches, defaults, environment-dependent validation, validation order, and every loader/model error branch without changing the loader. The unset-password case is marked as a schema exception because JSON Schema cannot observe `process.env`.

## Sidecars

Version 1 and the initial top-level field set are stable. Later lifecycle fields remain additive.

## Semantic versioning

Stable breaking changes require a major release; stable additions require a minor release. Except for the bridge CLI entry point, files under lib are internal implementation.

## Maintaining this document

Any slice changing a pinned module or pinned JSON input must run `node scripts/cli-surface.mjs --digest --write` before verification and commit the resulting document diff in the same reviewed commit. The command may update only `closure`, `module_digest`, and `input_digest`; behavior cases always require deliberate review.

```json public-api:skills
{
  "stability": "stable",
  "since": "0.18.0",
  "items": [
    {
      "stability": "stable",
      "since": "0.18.0",
      "skill": "execution",
      "command": {
        "name": "execute",
        "argument_hint": "driver=<interactive|autopilot> <plan-path>  |  omit arguments to resume one autopilot run"
      },
      "inputs": [
        "driver",
        "plan"
      ]
    },
    {
      "stability": "stable",
      "since": "0.18.0",
      "skill": "autopilot",
      "command": {
        "name": "autopilot",
        "argument_hint": "[plan-path]  (omit to resume the in-progress run)"
      },
      "inputs": [
        "plan",
        "spec"
      ]
    }
  ],
  "input_parse_rule": "Under ## Inputs, parse keys before : in the first fenced block. Under ## Required inputs, parse unique <name> placeholders in that section and strip a -path suffix."
}
```

```json public-api:cli-verbs
{
  "stability": "stable",
  "since": "0.18.0",
  "unknown_verb": {
    "exit": 2,
    "stderr_prefix": "available: "
  },
  "expansions": [
    {
      "site": "lib/codex-bridge/cli-harness/adapters/registry.js",
      "roots": "lib/codex-bridge/cli-harness/adapters/*.js",
      "inputs": "lib/codex-bridge/cli-clients/*.json",
      "call": "import(pathToFileURL(modulePath).href)"
    }
  ],
  "verbs": {
    "anchor-clear": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "repoRoot"
      ],
      "exits": [],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "repoRoot",
          "required": true,
          "value_type": "string"
        }
      ],
      "stdout_types": {},
      "exit_meanings": {},
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "anchor-clear"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-repoRoot",
          "invocation": {
            "args": [
              "anchor-clear",
              "--repoRoot",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "repoRoot"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "empty"
            }
          }
        }
      ]
    },
    "anchor-read": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "repoRoot"
      ],
      "exits": [],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "repoRoot",
          "required": true,
          "value_type": "string"
        }
      ],
      "stdout_types": {
        "json-present": {
          "specPath": "string"
        }
      },
      "exit_meanings": {},
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "anchor-read"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-repoRoot",
          "invocation": {
            "args": [
              "anchor-read",
              "--repoRoot",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "repoRoot"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "empty-valid-repo",
          "invocation": {
            "args": [
              "anchor-read",
              "--repoRoot",
              "$REPO"
            ],
            "stdin": "",
            "setup": "repo"
          },
          "covers": {
            "flags": [
              "repoRoot"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "json-present",
          "invocation": {
            "args": [
              "anchor-read",
              "--repoRoot",
              "$REPO"
            ],
            "stdin": "",
            "setup": "anchor-present"
          },
          "covers": {
            "flags": [
              "repoRoot"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "json-present"
            }
          }
        }
      ]
    },
    "anchor-write": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "repoRoot",
        "specPath"
      ],
      "exits": [],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "repoRoot",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "specPath",
          "required": true,
          "value_type": "string"
        }
      ],
      "stdout_types": {},
      "exit_meanings": {},
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "anchor-write"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-repoRoot",
          "invocation": {
            "args": [
              "anchor-write",
              "--repoRoot",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "repoRoot"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-specPath",
          "invocation": {
            "args": [
              "anchor-write",
              "--specPath",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "all-flags-success",
          "invocation": {
            "args": [
              "anchor-write",
              "--repoRoot",
              "$REPO",
              "--specPath",
              "$SPEC"
            ],
            "stdin": "",
            "setup": "repo"
          },
          "covers": {
            "flags": [
              "repoRoot",
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "empty"
            }
          }
        }
      ]
    },
    "app-state-get": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "specPath"
      ],
      "exits": [],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "specPath",
          "required": true,
          "value_type": "string"
        }
      ],
      "stdout_types": {
        "all-flags-success": {
          "initialized_at": "string",
          "goals": {
            "type": "object[]",
            "items": {
              "id": "string",
              "text": "string",
              "audited_shipped": "boolean",
              "shipped_by_plan": "string|null",
              "shipped_at": "string|null"
            }
          },
          "plans": {
            "type": "object[]",
            "items": {
              "path": "string",
              "shipped": "boolean",
              "audited_goals": "string[]",
              "shipped_at": "string|null"
            }
          },
          "active_plan": "string|null"
        }
      },
      "exit_meanings": {},
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "app-state-get"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-specPath",
          "invocation": {
            "args": [
              "app-state-get",
              "--specPath",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "empty-valid-sidecar",
          "invocation": {
            "args": [
              "app-state-get",
              "--specPath",
              "$SPEC"
            ],
            "stdin": "",
            "setup": "sidecar"
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "all-flags-success",
          "invocation": {
            "args": [
              "app-state-get",
              "--specPath",
              "$SPEC"
            ],
            "stdin": "",
            "setup": "app-state"
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "all-flags-success"
            }
          }
        }
      ]
    },
    "app-state-init": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "goals",
        "specPath"
      ],
      "exits": [
        2
      ],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "goals",
          "required": true,
          "value_type": "json"
        },
        {
          "name": "specPath",
          "required": true,
          "value_type": "string"
        }
      ],
      "stdout_types": {
        "all-flags-success": {
          "initialized_at": "string",
          "goals": {
            "type": "object[]",
            "items": {
              "id": "string",
              "text": "string",
              "audited_shipped": "boolean",
              "shipped_by_plan": "string|null",
              "shipped_at": "string|null"
            }
          },
          "plans": {
            "type": "object[]",
            "items": {
              "path": "string",
              "shipped": "boolean",
              "audited_goals": "string[]",
              "shipped_at": "string|null"
            }
          },
          "active_plan": "string|null"
        }
      },
      "exit_meanings": {
        "2": "usage or validation failure"
      },
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "app-state-init"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-goals",
          "invocation": {
            "args": [
              "app-state-init",
              "--goals",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "goals"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-specPath",
          "invocation": {
            "args": [
              "app-state-init",
              "--specPath",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "all-flags-success",
          "invocation": {
            "args": [
              "app-state-init",
              "--specPath",
              "$SPEC",
              "--goals",
              "[{\"id\":\"g\",\"text\":\"goal\"}]"
            ],
            "stdin": "",
            "setup": "sidecar"
          },
          "covers": {
            "flags": [
              "goals",
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "all-flags-success"
            }
          }
        }
      ]
    },
    "app-state-mark-goal-shipped": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "goalId",
        "planPath",
        "specPath"
      ],
      "exits": [
        2
      ],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "goalId",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "planPath",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "specPath",
          "required": true,
          "value_type": "string"
        }
      ],
      "stdout_types": {
        "all-flags-success": {
          "initialized_at": "string",
          "goals": {
            "type": "object[]",
            "items": {
              "id": "string",
              "text": "string",
              "audited_shipped": "boolean",
              "shipped_by_plan": "string|null",
              "shipped_at": "string|null"
            }
          },
          "plans": {
            "type": "object[]",
            "items": {
              "path": "string",
              "shipped": "boolean",
              "audited_goals": "string[]",
              "shipped_at": "string|null"
            }
          },
          "active_plan": "string|null"
        }
      },
      "exit_meanings": {
        "2": "usage or validation failure"
      },
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "app-state-mark-goal-shipped"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-goalId",
          "invocation": {
            "args": [
              "app-state-mark-goal-shipped",
              "--goalId",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "goalId"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-planPath",
          "invocation": {
            "args": [
              "app-state-mark-goal-shipped",
              "--planPath",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "planPath"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-specPath",
          "invocation": {
            "args": [
              "app-state-mark-goal-shipped",
              "--specPath",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "all-flags-success",
          "invocation": {
            "args": [
              "app-state-mark-goal-shipped",
              "--specPath",
              "$SPEC",
              "--goalId",
              "g",
              "--planPath",
              "plan.md"
            ],
            "stdin": "",
            "setup": "app-state"
          },
          "covers": {
            "flags": [
              "goalId",
              "planPath",
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "all-flags-success"
            }
          }
        }
      ]
    },
    "app-state-next-plan-context": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "specPath"
      ],
      "exits": [
        2
      ],
      "stdoutKeys": [
        "active_plan",
        "goals_shipped_count",
        "shipped_goals",
        "shipped_plans",
        "total_goals",
        "unshipped_goals"
      ],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "specPath",
          "required": true,
          "value_type": "string"
        }
      ],
      "stdout_types": {
        "initialized-json": {
          "unshipped_goals": {
            "type": "object[]",
            "items": {
              "id": "string",
              "text": "string"
            }
          },
          "shipped_goals": {
            "type": "object[]",
            "items": {
              "id": "string",
              "text": "string",
              "by_plan": "string"
            }
          },
          "shipped_plans": {
            "type": "object[]",
            "items": {
              "path": "string",
              "audited_goals": "string[]"
            }
          },
          "active_plan": "string|null",
          "total_goals": "number",
          "goals_shipped_count": "number"
        }
      },
      "exit_meanings": {
        "2": "usage or validation failure"
      },
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "app-state-next-plan-context"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-specPath",
          "invocation": {
            "args": [
              "app-state-next-plan-context",
              "--specPath",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "initialized-json",
          "invocation": {
            "args": [
              "app-state-next-plan-context",
              "--specPath",
              "$SPEC"
            ],
            "stdin": "",
            "setup": "app-state"
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": [
              "active_plan",
              "goals_shipped_count",
              "shipped_goals",
              "shipped_plans",
              "total_goals",
              "unshipped_goals"
            ]
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "initialized-json"
            }
          }
        },
        {
          "case": "uninitialized-usage",
          "invocation": {
            "args": [
              "app-state-next-plan-context",
              "--specPath",
              "$SPEC"
            ],
            "stdin": "",
            "setup": "sidecar"
          },
          "covers": {
            "flags": [],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        }
      ]
    },
    "app-state-set-plan": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "planPath",
        "shipped",
        "specPath",
        "started"
      ],
      "exits": [
        2
      ],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "planPath",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "shipped",
          "required": false,
          "value_type": "boolean"
        },
        {
          "name": "specPath",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "started",
          "required": false,
          "value_type": "boolean"
        }
      ],
      "stdout_types": {
        "all-flags-success": {
          "initialized_at": "string",
          "goals": {
            "type": "object[]",
            "items": {
              "id": "string",
              "text": "string",
              "audited_shipped": "boolean",
              "shipped_by_plan": "string|null",
              "shipped_at": "string|null"
            }
          },
          "plans": {
            "type": "object[]",
            "items": {
              "path": "string",
              "shipped": "boolean",
              "audited_goals": "string[]",
              "shipped_at": "string|null"
            }
          },
          "active_plan": "string|null"
        }
      },
      "exit_meanings": {
        "2": "usage or validation failure"
      },
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "app-state-set-plan"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-planPath",
          "invocation": {
            "args": [
              "app-state-set-plan",
              "--planPath",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "planPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-shipped",
          "invocation": {
            "args": [
              "app-state-set-plan",
              "--shipped"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "shipped"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-specPath",
          "invocation": {
            "args": [
              "app-state-set-plan",
              "--specPath",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-started",
          "invocation": {
            "args": [
              "app-state-set-plan",
              "--started"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "started"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "all-flags-success",
          "invocation": {
            "args": [
              "app-state-set-plan",
              "--specPath",
              "$SPEC",
              "--planPath",
              "plan.md",
              "--started",
              "--shipped"
            ],
            "stdin": "",
            "setup": "app-state"
          },
          "covers": {
            "flags": [
              "planPath",
              "shipped",
              "specPath",
              "started"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "all-flags-success"
            }
          }
        }
      ]
    },
    "checkout-preserve": {
      "stability": "stable",
      "since": "0.19.0",
      "flags": [
        "path",
        "reason",
        "repoRoot",
        "run"
      ],
      "exits": [
        2
      ],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "path",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "reason",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "repoRoot",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "run",
          "required": true,
          "value_type": "string"
        }
      ],
      "stdout_types": {},
      "exit_meanings": {
        "2": "usage error or path is not a registered worktree"
      },
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "checkout-preserve"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "all-flags-success",
          "invocation": {
            "args": [
              "checkout-preserve",
              "--path",
              "$REPO",
              "--reason",
              "contract evidence",
              "--run",
              "contract-run",
              "--repoRoot",
              "$REPO"
            ],
            "stdin": "",
            "setup": "repo"
          },
          "covers": {
            "flags": [
              "path",
              "reason",
              "repoRoot",
              "run"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "empty"
            }
          }
        }
      ]
    },
    "honest-reporting-clear": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "cwd"
      ],
      "exits": [],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "cwd",
          "required": false,
          "value_type": "string"
        }
      ],
      "stdout_types": {
        "baseline-no-args": {
          "path": "string",
          "cleared": "boolean"
        },
        "flag-cwd": {
          "path": "string",
          "cleared": "boolean"
        }
      },
      "exit_meanings": {},
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "honest-reporting-clear"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "baseline-no-args"
            }
          }
        },
        {
          "case": "flag-cwd",
          "invocation": {
            "args": [
              "honest-reporting-clear",
              "--cwd",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "cwd"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "flag-cwd"
            }
          }
        }
      ]
    },
    "honest-reporting-is-active": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "cwd"
      ],
      "exits": [],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "cwd",
          "required": false,
          "value_type": "string"
        }
      ],
      "stdout_types": {
        "no-marker": {
          "active": "boolean",
          "reason": "string",
          "marker": "null"
        },
        "flag-cwd": {
          "active": "boolean",
          "reason": "string",
          "marker": "null"
        },
        "active-marker": {
          "active": "boolean",
          "reason": "string",
          "marker": {
            "type": "object",
            "required": {
              "skillName": "string",
              "sessionStartedAt": "string",
              "expiresAt": "string"
            },
            "optional": {
              "specPath": "string"
            },
            "additional": false
          }
        },
        "expired-marker": {
          "active": "boolean",
          "reason": "string",
          "marker": {
            "type": "object",
            "required": {
              "skillName": "string",
              "sessionStartedAt": "string",
              "expiresAt": "string"
            },
            "optional": {
              "specPath": "string"
            },
            "additional": false
          }
        }
      },
      "exit_meanings": {},
      "cases": [
        {
          "case": "no-marker",
          "invocation": {
            "args": [
              "honest-reporting-is-active"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "no-marker",
              "field_values": {
                "active": false,
                "reason": "marker-absent-or-malformed",
                "marker": null
              }
            }
          }
        },
        {
          "case": "flag-cwd",
          "invocation": {
            "args": [
              "honest-reporting-is-active",
              "--cwd",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "cwd"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "flag-cwd"
            }
          }
        },
        {
          "case": "active-marker",
          "invocation": {
            "args": [
              "honest-reporting-is-active",
              "--cwd",
              "$TMP"
            ],
            "stdin": "",
            "setup": "honest-reporting-active"
          },
          "covers": {
            "flags": [
              "cwd"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "active-marker",
              "field_values": {
                "active": true,
                "reason": "active"
              }
            }
          }
        },
        {
          "case": "expired-marker",
          "invocation": {
            "args": [
              "honest-reporting-is-active",
              "--cwd",
              "$TMP"
            ],
            "stdin": "",
            "setup": "honest-reporting-expired"
          },
          "covers": {
            "flags": [
              "cwd"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "expired-marker",
              "field_values": {
                "active": false,
                "reason": "expired"
              }
            }
          }
        }
      ]
    },
    "honest-reporting-mark-active": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "cwd",
        "skill",
        "spec",
        "ttl-hours"
      ],
      "exits": [
        2
      ],
      "stdoutKeys": [
        "marker",
        "path"
      ],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "cwd",
          "required": false,
          "value_type": "string"
        },
        {
          "name": "skill",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "spec",
          "required": false,
          "value_type": "string"
        },
        {
          "name": "ttl-hours",
          "required": false,
          "value_type": "number"
        }
      ],
      "stdout_types": {
        "flag-skill": {
          "path": "string",
          "marker": {
            "skillName": "string",
            "sessionStartedAt": "string",
            "expiresAt": "string"
          }
        },
        "all-flags-success": {
          "path": "string",
          "marker": {
            "skillName": "string",
            "sessionStartedAt": "string",
            "expiresAt": "string",
            "specPath": "string"
          }
        }
      },
      "exit_meanings": {
        "2": "usage or validation failure"
      },
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "honest-reporting-mark-active"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-cwd",
          "invocation": {
            "args": [
              "honest-reporting-mark-active",
              "--cwd",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "cwd"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-skill",
          "invocation": {
            "args": [
              "honest-reporting-mark-active",
              "--skill",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "skill"
            ],
            "exits": [],
            "stdoutKeys": [
              "marker",
              "path"
            ]
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "flag-skill"
            }
          }
        },
        {
          "case": "flag-spec",
          "invocation": {
            "args": [
              "honest-reporting-mark-active",
              "--spec",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "spec"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-ttl-hours",
          "invocation": {
            "args": [
              "honest-reporting-mark-active",
              "--ttl-hours",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "ttl-hours"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "all-flags-success",
          "invocation": {
            "args": [
              "honest-reporting-mark-active",
              "--skill",
              "contract",
              "--spec",
              "$SPEC",
              "--ttl-hours",
              "1",
              "--cwd",
              "$REPO"
            ],
            "stdin": "",
            "setup": "repo"
          },
          "covers": {
            "flags": [
              "cwd",
              "skill",
              "spec",
              "ttl-hours"
            ],
            "exits": [],
            "stdoutKeys": [
              "marker",
              "path"
            ]
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "all-flags-success"
            }
          }
        }
      ]
    },
    "honest-reporting-marker-path": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "cwd"
      ],
      "exits": [],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "cwd",
          "required": false,
          "value_type": "string"
        }
      ],
      "stdout_types": {},
      "exit_meanings": {},
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "honest-reporting-marker-path"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "text",
              "pattern": "^/.*/\\.codex-paired/honest-reporting-active\\.json$"
            }
          }
        },
        {
          "case": "flag-cwd",
          "invocation": {
            "args": [
              "honest-reporting-marker-path",
              "--cwd",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "cwd"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "text",
              "pattern": "^/.*/\\.codex-paired/honest-reporting-active\\.json$"
            }
          }
        }
      ]
    },
    "honest-reporting-read-marker": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "cwd"
      ],
      "exits": [],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "cwd",
          "required": false,
          "value_type": "string"
        }
      ],
      "stdout_types": {
        "active-marker": {
          "type": "object",
          "required": {
            "skillName": "string",
            "sessionStartedAt": "string",
            "expiresAt": "string"
          },
          "optional": {
            "specPath": "string"
          },
          "additional": false
        },
        "expired-marker": {
          "type": "object",
          "required": {
            "skillName": "string",
            "sessionStartedAt": "string",
            "expiresAt": "string"
          },
          "optional": {
            "specPath": "string"
          },
          "additional": false
        }
      },
      "exit_meanings": {},
      "cases": [
        {
          "case": "no-marker",
          "invocation": {
            "args": [
              "honest-reporting-read-marker"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-cwd",
          "invocation": {
            "args": [
              "honest-reporting-read-marker",
              "--cwd",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "cwd"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "active-marker",
          "invocation": {
            "args": [
              "honest-reporting-read-marker",
              "--cwd",
              "$TMP"
            ],
            "stdin": "",
            "setup": "honest-reporting-active"
          },
          "covers": {
            "flags": [
              "cwd"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "active-marker"
            }
          }
        },
        {
          "case": "expired-marker",
          "invocation": {
            "args": [
              "honest-reporting-read-marker",
              "--cwd",
              "$TMP"
            ],
            "stdin": "",
            "setup": "honest-reporting-expired"
          },
          "covers": {
            "flags": [
              "cwd"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "expired-marker"
            }
          }
        }
      ]
    },
    "live-validation-parse": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "tier"
      ],
      "exits": [
        0,
        2
      ],
      "stdoutKeys": [
        "coverage",
        "tier"
      ],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "tier",
          "required": false,
          "value_type": "string"
        }
      ],
      "stdout_types": {
        "valid-standard-json": {
          "tier": "string",
          "coverage": {
            "live.scenarios-covered": "string",
            "live.preconditions-enforced": "string",
            "live.user-takeover-safe": "string",
            "live.evidence-quality": "string",
            "live.assertions-visible": "string",
            "live.logs-reviewed": "string",
            "live.flake-triaged": "string",
            "live.failures-fixed": "string",
            "live.regressions-rerun": "string",
            "live.cleanup-recorded": "string",
            "live.deferred-justified": "string",
            "live.environment-reproducible": "string",
            "live.residual-risk": "string"
          }
        },
        "all-flags-success": {
          "tier": "string",
          "coverage": {
            "live.scenarios-covered": "string",
            "live.preconditions-enforced": "string",
            "live.user-takeover-safe": "string",
            "live.evidence-quality": "string",
            "live.assertions-visible": "string",
            "live.logs-reviewed": "string",
            "live.flake-triaged": "string",
            "live.failures-fixed": "string",
            "live.regressions-rerun": "string",
            "live.cleanup-recorded": "string",
            "live.deferred-justified": "string",
            "live.environment-reproducible": "string",
            "live.residual-risk": "string"
          }
        }
      },
      "exit_meanings": {
        "0": "success",
        "2": "usage or validation failure"
      },
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "live-validation-parse"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-tier",
          "invocation": {
            "args": [
              "live-validation-parse",
              "--tier",
              "standard"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "tier"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "valid-standard-json",
          "invocation": {
            "args": [
              "live-validation-parse",
              "--tier",
              "standard"
            ],
            "stdin": "[\"tier: standard\",\"live.scenarios-covered: c\",\"live.preconditions-enforced: c\",\"live.user-takeover-safe: c\",\"live.evidence-quality: c\",\"live.assertions-visible: c\",\"live.logs-reviewed: c\",\"live.flake-triaged: c\",\"live.failures-fixed: c\",\"live.regressions-rerun: c\",\"live.cleanup-recorded: c\",\"live.deferred-justified: c\",\"live.environment-reproducible: c\",\"live.residual-risk: c\"]"
          },
          "covers": {
            "flags": [
              "tier"
            ],
            "exits": [
              0
            ],
            "stdoutKeys": [
              "coverage",
              "tier"
            ]
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "valid-standard-json"
            }
          }
        },
        {
          "case": "all-flags-success",
          "invocation": {
            "args": [
              "live-validation-parse",
              "--tier",
              "standard"
            ],
            "stdin": "[\"tier: standard\",\"live.scenarios-covered: c\",\"live.preconditions-enforced: c\",\"live.user-takeover-safe: c\",\"live.evidence-quality: c\",\"live.assertions-visible: c\",\"live.logs-reviewed: c\",\"live.flake-triaged: c\",\"live.failures-fixed: c\",\"live.regressions-rerun: c\",\"live.cleanup-recorded: c\",\"live.deferred-justified: c\",\"live.environment-reproducible: c\",\"live.residual-risk: c\"]"
          },
          "covers": {
            "flags": [
              "tier"
            ],
            "exits": [],
            "stdoutKeys": [
              "coverage",
              "tier"
            ]
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "all-flags-success"
            }
          }
        }
      ]
    },
    "mailbox-mark-read": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "actor",
        "for",
        "id",
        "repoRoot"
      ],
      "exits": [
        0,
        1,
        2
      ],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "actor",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "for",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "id",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "repoRoot",
          "required": false,
          "value_type": "string"
        }
      ],
      "stdout_types": {
        "success": {
          "alreadyRead": "boolean"
        },
        "all-flags-success": {
          "alreadyRead": "boolean"
        }
      },
      "exit_meanings": {
        "0": "success",
        "1": "operation failure",
        "2": "usage or validation failure"
      },
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "mailbox-mark-read"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-actor",
          "invocation": {
            "args": [
              "mailbox-mark-read",
              "--actor",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "actor"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-for",
          "invocation": {
            "args": [
              "mailbox-mark-read",
              "--for",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "for"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-id",
          "invocation": {
            "args": [
              "mailbox-mark-read",
              "--id",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "id"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-repoRoot",
          "invocation": {
            "args": [
              "mailbox-mark-read",
              "--repoRoot",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "repoRoot"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "success",
          "invocation": {
            "args": [
              "mailbox-mark-read",
              "--for",
              "orchestrator",
              "--actor",
              "orchestrator",
              "--id",
              "$MESSAGE_ID",
              "--repoRoot",
              "$REPO"
            ],
            "stdin": "",
            "setup": "mailbox-message"
          },
          "covers": {
            "flags": [
              "actor",
              "for",
              "id",
              "repoRoot"
            ],
            "exits": [
              0
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "success"
            }
          }
        },
        {
          "case": "operation-failure",
          "invocation": {
            "args": [
              "mailbox-mark-read",
              "--for",
              "orchestrator",
              "--actor",
              "orchestrator",
              "--id",
              "$MESSAGE_ID",
              "--repoRoot",
              "/dev/null"
            ],
            "stdin": "",
            "setup": "repo"
          },
          "covers": {
            "flags": [],
            "exits": [
              1
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "all-flags-success",
          "invocation": {
            "args": [
              "mailbox-mark-read",
              "--for",
              "orchestrator",
              "--actor",
              "orchestrator",
              "--id",
              "$MESSAGE_ID",
              "--repoRoot",
              "$REPO"
            ],
            "stdin": "",
            "setup": "mailbox-message"
          },
          "covers": {
            "flags": [
              "actor",
              "for",
              "id",
              "repoRoot"
            ],
            "exits": [
              0
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "all-flags-success"
            }
          }
        }
      ]
    },
    "mailbox-mark-read-batch": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "actor",
        "for",
        "message-ids",
        "repoRoot"
      ],
      "exits": [
        0,
        1,
        2
      ],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "actor",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "for",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "message-ids",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "repoRoot",
          "required": false,
          "value_type": "string"
        }
      ],
      "stdout_types": {
        "success": {
          "marked": "string[]",
          "skipped": "string[]"
        },
        "all-flags-success": {
          "marked": "string[]",
          "skipped": "string[]"
        }
      },
      "exit_meanings": {
        "0": "success",
        "1": "operation failure",
        "2": "usage or validation failure"
      },
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "mailbox-mark-read-batch"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-actor",
          "invocation": {
            "args": [
              "mailbox-mark-read-batch",
              "--actor",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "actor"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-for",
          "invocation": {
            "args": [
              "mailbox-mark-read-batch",
              "--for",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "for"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-message-ids",
          "invocation": {
            "args": [
              "mailbox-mark-read-batch",
              "--message-ids",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "message-ids"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-repoRoot",
          "invocation": {
            "args": [
              "mailbox-mark-read-batch",
              "--repoRoot",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "repoRoot"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "success",
          "invocation": {
            "args": [
              "mailbox-mark-read-batch",
              "--for",
              "orchestrator",
              "--actor",
              "orchestrator",
              "--message-ids",
              "msg-2026-01-01T00-00-00-000Z-0001",
              "--repoRoot",
              "$REPO"
            ],
            "stdin": "",
            "setup": "repo"
          },
          "covers": {
            "flags": [
              "actor",
              "for",
              "message-ids",
              "repoRoot"
            ],
            "exits": [
              0
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "success"
            }
          }
        },
        {
          "case": "operation-failure",
          "invocation": {
            "args": [
              "mailbox-mark-read-batch",
              "--for",
              "orchestrator",
              "--actor",
              "orchestrator",
              "--message-ids",
              "msg-2026-01-01T00-00-00-000Z-0001",
              "--repoRoot",
              "/dev/null"
            ],
            "stdin": "",
            "setup": "repo"
          },
          "covers": {
            "flags": [],
            "exits": [
              1
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "all-flags-success",
          "invocation": {
            "args": [
              "mailbox-mark-read-batch",
              "--for",
              "orchestrator",
              "--actor",
              "orchestrator",
              "--message-ids",
              "msg-2026-01-01T00-00-00-000Z-0001",
              "--repoRoot",
              "$REPO"
            ],
            "stdin": "",
            "setup": "repo"
          },
          "covers": {
            "flags": [
              "actor",
              "for",
              "message-ids",
              "repoRoot"
            ],
            "exits": [
              0
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "all-flags-success"
            }
          }
        }
      ]
    },
    "mailbox-read": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "actor",
        "for",
        "json",
        "repoRoot",
        "unread"
      ],
      "exits": [
        0,
        1,
        2
      ],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "actor",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "for",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "json",
          "required": false,
          "value_type": "boolean"
        },
        {
          "name": "repoRoot",
          "required": false,
          "value_type": "string"
        },
        {
          "name": "unread",
          "required": false,
          "value_type": "boolean"
        }
      ],
      "stdout_types": {
        "success": {
          "type": "object[]",
          "items": {
            "type": "object",
            "required": {
              "id": "string",
              "from": "string",
              "to": "string",
              "text": "string",
              "timestamp": "string",
              "summary": "string|null",
              "color": "string|null",
              "read_at": "string|null"
            },
            "optional": {
              "kind": "string",
              "priority": "string",
              "implementer_run_id": "string",
              "slice_id": "string",
              "body_hash": "string"
            },
            "additional": false
          }
        },
        "all-flags-success": {
          "type": "object[]",
          "items": {
            "type": "object",
            "required": {
              "id": "string",
              "from": "string",
              "to": "string",
              "text": "string",
              "timestamp": "string",
              "summary": "string|null",
              "color": "string|null",
              "read_at": "string|null"
            },
            "optional": {
              "kind": "string",
              "priority": "string",
              "implementer_run_id": "string",
              "slice_id": "string",
              "body_hash": "string"
            },
            "additional": false
          }
        }
      },
      "exit_meanings": {
        "0": "success",
        "1": "operation failure",
        "2": "usage or validation failure"
      },
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "mailbox-read"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [
              2,
              1
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-actor",
          "invocation": {
            "args": [
              "mailbox-read",
              "--actor",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "actor"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-for",
          "invocation": {
            "args": [
              "mailbox-read",
              "--for",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "for"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-json",
          "invocation": {
            "args": [
              "mailbox-read",
              "--json"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "json"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-repoRoot",
          "invocation": {
            "args": [
              "mailbox-read",
              "--repoRoot",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "repoRoot"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-unread",
          "invocation": {
            "args": [
              "mailbox-read",
              "--unread"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "unread"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "success",
          "invocation": {
            "args": [
              "mailbox-read",
              "--for",
              "orchestrator",
              "--actor",
              "orchestrator",
              "--repoRoot",
              "$REPO"
            ],
            "stdin": "",
            "setup": "mailbox-message"
          },
          "covers": {
            "flags": [
              "actor",
              "for",
              "repoRoot"
            ],
            "exits": [
              0
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "success"
            }
          }
        },
        {
          "case": "all-flags-success",
          "invocation": {
            "args": [
              "mailbox-read",
              "--for",
              "orchestrator",
              "--actor",
              "orchestrator",
              "--json",
              "--unread",
              "--repoRoot",
              "$REPO"
            ],
            "stdin": "",
            "setup": "mailbox-message"
          },
          "covers": {
            "flags": [
              "actor",
              "for",
              "json",
              "repoRoot",
              "unread"
            ],
            "exits": [
              0
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "all-flags-success"
            }
          }
        }
      ],
      "manual": {
        "reason": "the literal exit 1 is a defensive catch for a non-MailboxError, while all current readMailbox storage failures are normalized to exit 2",
        "region_digest": "sha256:d3123ac61f48f81e830b09c436e348ecab4f96fee846806824e8188c72182240"
      }
    },
    "mailbox-write": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "color",
        "from",
        "message-json-stdin",
        "repoRoot",
        "summary",
        "text",
        "text-stdin",
        "to"
      ],
      "exits": [
        0,
        1,
        2
      ],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "color",
          "required": false,
          "value_type": "string"
        },
        {
          "name": "from",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "message-json-stdin",
          "required": false,
          "value_type": "boolean"
        },
        {
          "name": "repoRoot",
          "required": false,
          "value_type": "string"
        },
        {
          "name": "summary",
          "required": false,
          "value_type": "string"
        },
        {
          "name": "text",
          "required": false,
          "value_type": "string"
        },
        {
          "name": "text-stdin",
          "required": false,
          "value_type": "boolean"
        },
        {
          "name": "to",
          "required": true,
          "value_type": "string"
        }
      ],
      "stdout_types": {
        "success": {
          "id": "string"
        },
        "text-flags-success": {
          "id": "string"
        },
        "text-stdin-success": {
          "id": "string"
        },
        "message-json-stdin-success": {
          "id": "string"
        }
      },
      "exit_meanings": {
        "0": "success",
        "1": "operation failure",
        "2": "usage or validation failure"
      },
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "mailbox-write"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-color",
          "invocation": {
            "args": [
              "mailbox-write",
              "--color",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "color"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-from",
          "invocation": {
            "args": [
              "mailbox-write",
              "--from",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "from"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-message-json-stdin",
          "invocation": {
            "args": [
              "mailbox-write",
              "--message-json-stdin"
            ],
            "stdin": "{}"
          },
          "covers": {
            "flags": [
              "message-json-stdin"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-repoRoot",
          "invocation": {
            "args": [
              "mailbox-write",
              "--repoRoot",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "repoRoot"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-summary",
          "invocation": {
            "args": [
              "mailbox-write",
              "--summary",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "summary"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-text",
          "invocation": {
            "args": [
              "mailbox-write",
              "--text",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "text"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-text-stdin",
          "invocation": {
            "args": [
              "mailbox-write",
              "--text-stdin"
            ],
            "stdin": "contract"
          },
          "covers": {
            "flags": [
              "text-stdin"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-to",
          "invocation": {
            "args": [
              "mailbox-write",
              "--to",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "to"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "success",
          "invocation": {
            "args": [
              "mailbox-write",
              "--to",
              "orchestrator",
              "--from",
              "slice-1",
              "--text",
              "contract",
              "--repoRoot",
              "$REPO"
            ],
            "stdin": "",
            "setup": "repo"
          },
          "covers": {
            "flags": [
              "from",
              "repoRoot",
              "text",
              "to"
            ],
            "exits": [
              0
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "success"
            }
          }
        },
        {
          "case": "operation-failure",
          "invocation": {
            "args": [
              "mailbox-write",
              "--to",
              "orchestrator",
              "--from",
              "slice-1",
              "--text",
              "contract",
              "--repoRoot",
              "/dev/null"
            ],
            "stdin": "",
            "setup": "repo"
          },
          "covers": {
            "flags": [],
            "exits": [
              1
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "text-flags-success",
          "invocation": {
            "args": [
              "mailbox-write",
              "--to",
              "orchestrator",
              "--from",
              "slice-1",
              "--text",
              "contract",
              "--summary",
              "summary",
              "--color",
              "blue",
              "--repoRoot",
              "$REPO"
            ],
            "stdin": "",
            "setup": "repo"
          },
          "covers": {
            "flags": [
              "to",
              "from",
              "text",
              "summary",
              "color",
              "repoRoot"
            ],
            "exits": [
              0
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "text-flags-success"
            }
          }
        },
        {
          "case": "text-stdin-success",
          "invocation": {
            "args": [
              "mailbox-write",
              "--to",
              "orchestrator",
              "--from",
              "slice-1",
              "--text-stdin",
              "--repoRoot",
              "$REPO"
            ],
            "stdin": "contract",
            "setup": "repo"
          },
          "covers": {
            "flags": [
              "to",
              "from",
              "text-stdin",
              "repoRoot"
            ],
            "exits": [
              0
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "text-stdin-success"
            }
          }
        },
        {
          "case": "message-json-stdin-success",
          "invocation": {
            "args": [
              "mailbox-write",
              "--to",
              "orchestrator",
              "--from",
              "slice-1",
              "--message-json-stdin",
              "--repoRoot",
              "$REPO"
            ],
            "stdin": "{\"text\":\"contract\",\"summary\":\"summary\",\"color\":\"blue\"}",
            "setup": "repo"
          },
          "covers": {
            "flags": [
              "to",
              "from",
              "message-json-stdin",
              "repoRoot"
            ],
            "exits": [
              0
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "message-json-stdin-success"
            }
          }
        }
      ]
    },
    "model-role": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "format",
        "repoRoot",
        "role"
      ],
      "exits": [
        2
      ],
      "stdoutKeys": [
        "args",
        "cli",
        "command",
        "effort",
        "insertAfter",
        "model",
        "role",
        "sources"
      ],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "format",
          "required": false,
          "value_type": "json|flags|mcp"
        },
        {
          "name": "repoRoot",
          "required": false,
          "value_type": "string"
        },
        {
          "name": "role",
          "required": true,
          "value_type": "string"
        }
      ],
      "stdout_types": {
        "planning-json": {
          "role": "string",
          "cli": "string",
          "model": "string",
          "effort": "string",
          "command": "string",
          "args": "string[]",
          "insertAfter": "string",
          "sources": {
            "cli": "string",
            "model": "string",
            "effort": "string"
          }
        },
        "planning-mcp": {
          "model": "string",
          "config": {
            "model_reasoning_effort": "string"
          }
        },
        "all-flags-success": {
          "role": "string",
          "cli": "string",
          "model": "string",
          "effort": "string",
          "command": "string",
          "args": "string[]",
          "insertAfter": "string",
          "sources": {
            "cli": "string",
            "model": "string",
            "effort": "string"
          }
        }
      },
      "exit_meanings": {
        "2": "usage or validation failure"
      },
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "model-role"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "planning-json",
          "invocation": {
            "args": [
              "model-role",
              "--role",
              "planning",
              "--format",
              "json"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "role",
              "format"
            ],
            "exits": [],
            "stdoutKeys": [
              "args",
              "cli",
              "command",
              "effort",
              "insertAfter",
              "model",
              "role",
              "sources"
            ]
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "planning-json"
            }
          }
        },
        {
          "case": "planning-flags",
          "invocation": {
            "args": [
              "model-role",
              "--role",
              "planning",
              "--format",
              "flags"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "role",
              "format"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "text",
              "exact": "-m gpt-6-astra -c model_reasoning_effort=xhigh"
            }
          }
        },
        {
          "case": "planning-mcp",
          "invocation": {
            "args": [
              "model-role",
              "--role",
              "planning",
              "--format",
              "mcp"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "role",
              "format"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "planning-mcp"
            }
          }
        },
        {
          "case": "flag-format",
          "invocation": {
            "args": [
              "model-role",
              "--format",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "format"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-repoRoot",
          "invocation": {
            "args": [
              "model-role",
              "--repoRoot",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "repoRoot"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-role",
          "invocation": {
            "args": [
              "model-role",
              "--role",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "role"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "all-flags-success",
          "invocation": {
            "args": [
              "model-role",
              "--role",
              "planning",
              "--repoRoot",
              "$REPO",
              "--format",
              "json"
            ],
            "stdin": "",
            "setup": "repo"
          },
          "covers": {
            "flags": [
              "format",
              "repoRoot",
              "role"
            ],
            "exits": [],
            "stdoutKeys": [
              "args",
              "cli",
              "command",
              "effort",
              "insertAfter",
              "model",
              "role",
              "sources"
            ]
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "all-flags-success"
            }
          }
        }
      ]
    },
    "model-roles": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "repoRoot"
      ],
      "exits": [],
      "stdoutKeys": [
        "validated_cli_version"
      ],
      "unsupported": [
        "stdout-spread"
      ],
      "flag_contract": [
        {
          "name": "repoRoot",
          "required": false,
          "value_type": "string"
        }
      ],
      "stdout_types": {
        "baseline-no-args": {
          "roles": {
            "planning": {
              "cli": "string",
              "model": "string",
              "effort": "string"
            },
            "review": {
              "cli": "string",
              "model": "string",
              "effort": "string"
            },
            "implement": {
              "cli": "string",
              "model": "string",
              "effort": "string"
            },
            "implement_fallback": {
              "cli": "string",
              "model": "string",
              "effort": "string"
            }
          },
          "sources": {
            "planning": {
              "cli": "string",
              "model": "string",
              "effort": "string"
            },
            "review": {
              "cli": "string",
              "model": "string",
              "effort": "string"
            },
            "implement": {
              "cli": "string",
              "model": "string",
              "effort": "string"
            },
            "implement_fallback": {
              "cli": "string",
              "model": "string",
              "effort": "string"
            }
          },
          "validated_cli_version": "string"
        },
        "flag-repoRoot": {
          "roles": {
            "planning": {
              "cli": "string",
              "model": "string",
              "effort": "string"
            },
            "review": {
              "cli": "string",
              "model": "string",
              "effort": "string"
            },
            "implement": {
              "cli": "string",
              "model": "string",
              "effort": "string"
            },
            "implement_fallback": {
              "cli": "string",
              "model": "string",
              "effort": "string"
            }
          },
          "sources": {
            "planning": {
              "cli": "string",
              "model": "string",
              "effort": "string"
            },
            "review": {
              "cli": "string",
              "model": "string",
              "effort": "string"
            },
            "implement": {
              "cli": "string",
              "model": "string",
              "effort": "string"
            },
            "implement_fallback": {
              "cli": "string",
              "model": "string",
              "effort": "string"
            }
          },
          "validated_cli_version": "string"
        }
      },
      "exit_meanings": {},
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "model-roles"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [],
            "stdoutKeys": [
              "validated_cli_version"
            ]
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "baseline-no-args"
            }
          }
        },
        {
          "case": "flag-repoRoot",
          "invocation": {
            "args": [
              "model-roles",
              "--repoRoot",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "repoRoot"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "flag-repoRoot"
            }
          }
        }
      ],
      "manual": {
        "reason": "stdout object spread requires manual review of the complete handler region",
        "region_digest": "sha256:105584241c5c05c13b4a1a79e14fb349cc9606c93155bf23ff568246c8b04f99"
      }
    },
    "panel-reduce": {
      "stability": "stable",
      "since": "0.19.0",
      "flags": [],
      "exits": [
        1,
        2
      ],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [],
      "stdout_types": {
        "reduction": {
          "status": "string",
          "blocking": {
            "type": "object[]",
            "items": {
              "member_id": "string",
              "finding": "string"
            }
          },
          "deferred": {
            "type": "object[]",
            "items": {
              "member_id": "string",
              "finding": "string"
            }
          }
        }
      },
      "exit_meanings": {
        "1": "panel halt",
        "2": "usage or validation failure"
      },
      "cases": [
        {
          "case": "baseline-empty-stdin",
          "invocation": {
            "args": [
              "panel-reduce"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "member-halt",
          "invocation": {
            "args": [
              "panel-reduce"
            ],
            "stdin": "{\"roster\":[{\"member_id\":\"codex:gpt-a\",\"cli\":\"codex\",\"model\":\"gpt-a\",\"effort\":\"high\"}],\"version\":\"v1\",\"claude\":{\"status\":\"SHIP\",\"critique\":[],\"rationale\":\"ok\",\"deferred\":[],\"version\":\"v1\"},\"members\":[{\"member_id\":\"codex:gpt-a\",\"verdict\":{\"status\":\"SHIP\",\"critique\":[],\"rationale\":\"ok\",\"deferred\":[],\"version\":\"wrong\"}}]}"
          },
          "covers": {
            "flags": [],
            "exits": [
              1
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "unanimous-ship",
          "invocation": {
            "args": [
              "panel-reduce"
            ],
            "stdin": "{\"roster\":[{\"member_id\":\"codex:gpt-a\",\"cli\":\"codex\",\"model\":\"gpt-a\",\"effort\":\"high\"}],\"version\":\"v1\",\"claude\":{\"status\":\"SHIP\",\"critique\":[],\"rationale\":\"ok\",\"deferred\":[],\"version\":\"v1\"},\"members\":[{\"member_id\":\"codex:gpt-a\",\"verdict\":{\"status\":\"SHIP\",\"critique\":[],\"rationale\":\"ok\",\"deferred\":[],\"version\":\"v1\"}}]}"
          },
          "covers": {
            "flags": [],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "reduction"
            }
          }
        }
      ]
    },
    "parse-skip-frontmatter": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [],
      "exits": [
        0,
        2
      ],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [],
      "stdout_types": {
        "without-reason": {
          "skip": "boolean"
        },
        "with-reason": {
          "skip": "boolean",
          "reason": "string"
        }
      },
      "exit_meanings": {
        "0": "success",
        "2": "usage or validation failure"
      },
      "cases": [
        {
          "case": "without-reason",
          "invocation": {
            "args": [
              "parse-skip-frontmatter"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [
              0
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "without-reason",
              "field_values": {
                "skip": false
              }
            }
          }
        },
        {
          "case": "with-reason",
          "invocation": {
            "args": [
              "parse-skip-frontmatter"
            ],
            "stdin": "live-verification: skip - contract probe"
          },
          "covers": {
            "flags": [],
            "exits": [
              0
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "with-reason",
              "field_values": {
                "skip": true,
                "reason": "contract probe"
              }
            }
          }
        },
        {
          "case": "malformed-directive",
          "invocation": {
            "args": [
              "parse-skip-frontmatter"
            ],
            "stdin": "live-verification: skip"
          },
          "covers": {
            "flags": [],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        }
      ]
    },
    "review-panel": {
      "stability": "stable",
      "since": "0.19.0",
      "flags": [
        "format",
        "phase",
        "repoRoot"
      ],
      "exits": [
        2
      ],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "format",
          "required": false,
          "value_type": "json"
        },
        {
          "name": "phase",
          "required": true,
          "value_type": "planning|review"
        },
        {
          "name": "repoRoot",
          "required": true,
          "value_type": "string"
        }
      ],
      "stdout_types": {
        "resolved-roster": {
          "type": "object[]",
          "items": {
            "member_id": "string",
            "cli": "string",
            "model": "string",
            "effort": "string"
          }
        }
      },
      "exit_meanings": {
        "2": "usage or configuration failure"
      },
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "review-panel"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "resolved-roster",
          "invocation": {
            "args": [
              "review-panel",
              "--phase",
              "planning",
              "--repoRoot",
              "$REPO",
              "--format",
              "json"
            ],
            "stdin": "",
            "setup": "repo"
          },
          "covers": {
            "flags": [
              "format",
              "phase",
              "repoRoot"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "resolved-roster"
            }
          }
        }
      ]
    },
    "review-panel-member": {
      "stability": "stable",
      "since": "0.19.0",
      "flags": [
        "member-id",
        "model",
        "planPath",
        "repoRoot",
        "role",
        "sha",
        "specPath",
        "timeout-ms",
        "version"
      ],
      "exits": [
        1,
        2
      ],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "member-id",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "model",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "planPath",
          "required": false,
          "value_type": "string"
        },
        {
          "name": "repoRoot",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "role",
          "required": true,
          "value_type": "planning|review"
        },
        {
          "name": "sha",
          "required": false,
          "value_type": "string"
        },
        {
          "name": "specPath",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "timeout-ms",
          "required": false,
          "value_type": "non-negative integer"
        },
        {
          "name": "version",
          "required": true,
          "value_type": "string"
        }
      ],
      "stdout_types": {
        "member-result": {
          "member_id": "string",
          "verdict": {
            "status": "string",
            "critique": "string[]",
            "rationale": "string",
            "deferred": "string[]",
            "version": "string|null"
          },
          "conversation_id": "string|null",
          "usage": "json"
        }
      },
      "exit_meanings": {
        "1": "member turn failure",
        "2": "usage or validation failure"
      },
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "review-panel-member"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "member-failure",
          "invocation": {
            "args": [
              "review-panel-member",
              "--role",
              "review",
              "--specPath",
              "$SPEC",
              "--repoRoot",
              "$REPO",
              "--member-id",
              "agy:gemini-3.8-flash-high",
              "--model",
              "gemini-3.8-flash-high",
              "--version",
              "v1"
            ],
            "stdin": "round 1",
            "setup": "reviewer-failure"
          },
          "covers": {
            "flags": [],
            "exits": [
              1
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "all-flags-success",
          "invocation": {
            "args": [
              "review-panel-member",
              "--role",
              "review",
              "--specPath",
              "$SPEC",
              "--repoRoot",
              "$REPO",
              "--member-id",
              "agy:gemini-3.8-flash-high",
              "--model",
              "gemini-3.8-flash-high",
              "--version",
              "v1",
              "--sha",
              "$HEAD",
              "--planPath",
              "$SPEC",
              "--timeout-ms",
              "5000"
            ],
            "stdin": "round 1",
            "setup": "reviewer-success",
            "env": {
              "FAKE_AGY_RESPONSE": "<<<VERDICT>>>\nstatus: SHIP\nversion: v1\ncritique: []\ndeferred: []\nrationale: checked\n<<<END>>>"
            }
          },
          "covers": {
            "flags": [
              "member-id",
              "model",
              "planPath",
              "repoRoot",
              "role",
              "sha",
              "specPath",
              "timeout-ms",
              "version"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "member-result"
            }
          }
        }
      ]
    },
    "reviewer-thread-open": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "planPath",
        "repoRoot",
        "role",
        "sha",
        "specPath"
      ],
      "exits": [
        1,
        2
      ],
      "stdoutKeys": [
        "content",
        "exit",
        "ok",
        "status",
        "threadId",
        "usage",
        "warnings"
      ],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "planPath",
          "required": false,
          "value_type": "string"
        },
        {
          "name": "repoRoot",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "role",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "sha",
          "required": false,
          "value_type": "string"
        },
        {
          "name": "specPath",
          "required": true,
          "value_type": "string"
        }
      ],
      "stdout_types": {
        "agy-success-json": {
          "threadId": "string",
          "content": "string",
          "usage": {
            "type": "object|null",
            "required": {
              "prompt_tokens": "number",
              "completion_tokens": "number",
              "total_tokens": "number"
            },
            "additional": false
          },
          "ok": "boolean",
          "exit": "number",
          "status": "string",
          "warnings": "string[]"
        },
        "agy-failure-json": {
          "threadId": "string",
          "content": "string",
          "usage": {
            "type": "object|null",
            "required": {
              "prompt_tokens": "number",
              "completion_tokens": "number",
              "total_tokens": "number"
            },
            "additional": false
          },
          "ok": "boolean",
          "exit": "number",
          "status": "string",
          "warnings": "string[]"
        },
        "all-flags-success": {
          "threadId": "string",
          "content": "string",
          "usage": {
            "type": "object|null",
            "required": {
              "prompt_tokens": "number",
              "completion_tokens": "number",
              "total_tokens": "number"
            },
            "additional": false
          },
          "ok": "boolean",
          "exit": "number",
          "status": "string",
          "warnings": "string[]"
        }
      },
      "exit_meanings": {
        "1": "operation failure",
        "2": "usage or validation failure"
      },
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "reviewer-thread-open"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-planPath",
          "invocation": {
            "args": [
              "reviewer-thread-open",
              "--planPath",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "planPath"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-repoRoot",
          "invocation": {
            "args": [
              "reviewer-thread-open",
              "--repoRoot",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "repoRoot"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-role",
          "invocation": {
            "args": [
              "reviewer-thread-open",
              "--role",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "role"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-sha",
          "invocation": {
            "args": [
              "reviewer-thread-open",
              "--sha",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "sha"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-specPath",
          "invocation": {
            "args": [
              "reviewer-thread-open",
              "--specPath",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "agy-success-json",
          "invocation": {
            "args": [
              "reviewer-thread-open",
              "--role",
              "review",
              "--specPath",
              "$SPEC",
              "--repoRoot",
              "$REPO"
            ],
            "stdin": "review",
            "setup": "reviewer-success"
          },
          "covers": {
            "flags": [
              "repoRoot",
              "role",
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": [
              "content",
              "exit",
              "ok",
              "status",
              "threadId",
              "usage",
              "warnings"
            ]
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "agy-success-json"
            }
          }
        },
        {
          "case": "agy-failure-json",
          "invocation": {
            "args": [
              "reviewer-thread-open",
              "--role",
              "review",
              "--specPath",
              "$SPEC",
              "--repoRoot",
              "$REPO"
            ],
            "stdin": "review",
            "setup": "reviewer-null-usage"
          },
          "covers": {
            "flags": [],
            "exits": [
              1
            ],
            "stdoutKeys": [
              "content",
              "exit",
              "ok",
              "status",
              "threadId",
              "usage",
              "warnings"
            ]
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "json",
              "schema": "agy-failure-json"
            }
          }
        },
        {
          "case": "all-flags-success",
          "invocation": {
            "args": [
              "reviewer-thread-open",
              "--role",
              "review",
              "--specPath",
              "$SPEC",
              "--repoRoot",
              "$REPO",
              "--sha",
              "$HEAD",
              "--planPath",
              "$SPEC"
            ],
            "stdin": "review",
            "setup": "reviewer-success"
          },
          "covers": {
            "flags": [
              "planPath",
              "repoRoot",
              "role",
              "sha",
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": [
              "content",
              "exit",
              "ok",
              "status",
              "threadId",
              "usage",
              "warnings"
            ]
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "all-flags-success"
            }
          }
        }
      ]
    },
    "reviewer-thread-reply": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "planPath",
        "repoRoot",
        "role",
        "sha",
        "specPath"
      ],
      "exits": [
        1,
        2
      ],
      "stdoutKeys": [
        "content",
        "exit",
        "ok",
        "status",
        "threadId",
        "usage",
        "warnings"
      ],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "planPath",
          "required": false,
          "value_type": "string"
        },
        {
          "name": "repoRoot",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "role",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "sha",
          "required": false,
          "value_type": "string"
        },
        {
          "name": "specPath",
          "required": true,
          "value_type": "string"
        }
      ],
      "stdout_types": {
        "agy-success-json": {
          "threadId": "string",
          "content": "string",
          "usage": {
            "type": "object|null",
            "required": {
              "prompt_tokens": "number",
              "completion_tokens": "number",
              "total_tokens": "number"
            },
            "additional": false
          },
          "ok": "boolean",
          "exit": "number",
          "status": "string",
          "warnings": "string[]"
        },
        "agy-failure-json": {
          "threadId": "string",
          "content": "string",
          "usage": {
            "type": "object|null",
            "required": {
              "prompt_tokens": "number",
              "completion_tokens": "number",
              "total_tokens": "number"
            },
            "additional": false
          },
          "ok": "boolean",
          "exit": "number",
          "status": "string",
          "warnings": "string[]"
        },
        "all-flags-success": {
          "threadId": "string",
          "content": "string",
          "usage": {
            "type": "object|null",
            "required": {
              "prompt_tokens": "number",
              "completion_tokens": "number",
              "total_tokens": "number"
            },
            "additional": false
          },
          "ok": "boolean",
          "exit": "number",
          "status": "string",
          "warnings": "string[]"
        }
      },
      "exit_meanings": {
        "1": "operation failure",
        "2": "usage or validation failure"
      },
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "reviewer-thread-reply"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-planPath",
          "invocation": {
            "args": [
              "reviewer-thread-reply",
              "--planPath",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "planPath"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-repoRoot",
          "invocation": {
            "args": [
              "reviewer-thread-reply",
              "--repoRoot",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "repoRoot"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-role",
          "invocation": {
            "args": [
              "reviewer-thread-reply",
              "--role",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "role"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-sha",
          "invocation": {
            "args": [
              "reviewer-thread-reply",
              "--sha",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "sha"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-specPath",
          "invocation": {
            "args": [
              "reviewer-thread-reply",
              "--specPath",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "agy-success-json",
          "invocation": {
            "args": [
              "reviewer-thread-reply",
              "--role",
              "review",
              "--specPath",
              "$SPEC",
              "--repoRoot",
              "$REPO"
            ],
            "stdin": "review",
            "setup": "reviewer-reply"
          },
          "covers": {
            "flags": [
              "repoRoot",
              "role",
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": [
              "content",
              "exit",
              "ok",
              "status",
              "threadId",
              "usage",
              "warnings"
            ]
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "agy-success-json"
            }
          }
        },
        {
          "case": "agy-failure-json",
          "invocation": {
            "args": [
              "reviewer-thread-reply",
              "--role",
              "review",
              "--specPath",
              "$SPEC",
              "--repoRoot",
              "$REPO"
            ],
            "stdin": "review",
            "setup": "reviewer-null-usage"
          },
          "covers": {
            "flags": [],
            "exits": [
              1
            ],
            "stdoutKeys": [
              "content",
              "exit",
              "ok",
              "status",
              "threadId",
              "usage",
              "warnings"
            ]
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "json",
              "schema": "agy-failure-json"
            }
          }
        },
        {
          "case": "all-flags-success",
          "invocation": {
            "args": [
              "reviewer-thread-reply",
              "--role",
              "review",
              "--specPath",
              "$SPEC",
              "--repoRoot",
              "$REPO",
              "--sha",
              "$HEAD",
              "--planPath",
              "$SPEC"
            ],
            "stdin": "review",
            "setup": "reviewer-reply"
          },
          "covers": {
            "flags": [
              "planPath",
              "repoRoot",
              "role",
              "sha",
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": [
              "content",
              "exit",
              "ok",
              "status",
              "threadId",
              "usage",
              "warnings"
            ]
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "all-flags-success"
            }
          }
        }
      ]
    },
    "scenario-validate": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "require-scenarios"
      ],
      "exits": [
        0,
        2
      ],
      "stdoutKeys": [
        "deferred",
        "ok",
        "scenarios"
      ],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "require-scenarios",
          "required": false,
          "value_type": "boolean"
        }
      ],
      "stdout_types": {
        "valid-scenario-json": {
          "ok": "boolean",
          "scenarios": {
            "type": "object[]",
            "items": {
              "type": "object",
              "required": {
                "id": "string"
              },
              "optional": {
                "title": "string",
                "risk": "string",
                "why": "string",
                "preconditions": {
                  "type": "object[]",
                  "items": {
                    "type": "object",
                    "required": {},
                    "additional": true
                  }
                },
                "steps": {
                  "type": "object[]",
                  "items": {
                    "type": "object",
                    "required": {},
                    "additional": true
                  }
                },
                "assertions": "string[]",
                "diagnostic_expectations": "json[]",
                "timeout_ms": "number"
              },
              "additional": true
            }
          },
          "deferred": "string[]"
        },
        "all-flags-success": {
          "ok": "boolean",
          "scenarios": {
            "type": "object[]",
            "items": {
              "type": "object",
              "required": {
                "id": "string"
              },
              "optional": {
                "title": "string",
                "risk": "string",
                "why": "string",
                "preconditions": {
                  "type": "object[]",
                  "items": {
                    "type": "object",
                    "required": {},
                    "additional": true
                  }
                },
                "steps": {
                  "type": "object[]",
                  "items": {
                    "type": "object",
                    "required": {},
                    "additional": true
                  }
                },
                "assertions": "string[]",
                "diagnostic_expectations": "json[]",
                "timeout_ms": "number"
              },
              "additional": true
            }
          },
          "deferred": "string[]"
        }
      },
      "exit_meanings": {
        "0": "success",
        "2": "usage or validation failure"
      },
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "scenario-validate"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-require-scenarios",
          "invocation": {
            "args": [
              "scenario-validate",
              "--require-scenarios"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "require-scenarios"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "valid-scenario-json",
          "invocation": {
            "args": [
              "scenario-validate"
            ],
            "stdin": "{\"scenarios\":[{\"id\":\"lv-001\",\"title\":\"contract\",\"risk\":\"happy-path\",\"why\":\"contract\",\"preconditions\":[],\"steps\":[{\"action\":\"click\",\"target\":\"Button\"}],\"assertions\":[\"Visible\"],\"diagnostic_expectations\":[],\"timeout_ms\":60000}],\"deferred\":[\"lv-deferred\"]}"
          },
          "covers": {
            "flags": [],
            "exits": [
              0
            ],
            "stdoutKeys": [
              "deferred",
              "ok",
              "scenarios"
            ]
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "valid-scenario-json"
            }
          }
        },
        {
          "case": "all-flags-success",
          "invocation": {
            "args": [
              "scenario-validate",
              "--require-scenarios"
            ],
            "stdin": "{\"scenarios\":[{\"id\":\"lv-001\",\"title\":\"contract\",\"risk\":\"happy-path\",\"why\":\"contract\",\"preconditions\":[],\"steps\":[{\"action\":\"click\",\"target\":\"Button\"}],\"assertions\":[\"Visible\"],\"diagnostic_expectations\":[],\"timeout_ms\":60000}],\"deferred\":[\"lv-deferred\"]}"
          },
          "covers": {
            "flags": [
              "require-scenarios"
            ],
            "exits": [],
            "stdoutKeys": [
              "deferred",
              "ok",
              "scenarios"
            ]
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "all-flags-success"
            }
          }
        }
      ]
    },
    "sidecar-add-contention": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "contention",
        "specPath"
      ],
      "exits": [],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "contention",
          "required": true,
          "value_type": "json"
        },
        {
          "name": "specPath",
          "required": true,
          "value_type": "string"
        }
      ],
      "stdout_types": {},
      "exit_meanings": {},
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "sidecar-add-contention"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-contention",
          "invocation": {
            "args": [
              "sidecar-add-contention",
              "--contention",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "contention"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-specPath",
          "invocation": {
            "args": [
              "sidecar-add-contention",
              "--specPath",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "all-flags-success",
          "invocation": {
            "args": [
              "sidecar-add-contention",
              "--specPath",
              "$SPEC",
              "--contention",
              "{\"topic\":\"contract\"}"
            ],
            "stdin": "",
            "setup": "sidecar"
          },
          "covers": {
            "flags": [
              "contention",
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "empty"
            }
          }
        }
      ]
    },
    "sidecar-append-audit": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "audit",
        "specPath"
      ],
      "exits": [
        2
      ],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "audit",
          "required": true,
          "value_type": "json"
        },
        {
          "name": "specPath",
          "required": true,
          "value_type": "string"
        }
      ],
      "stdout_types": {},
      "exit_meanings": {
        "2": "usage or validation failure"
      },
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "sidecar-append-audit"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-audit",
          "invocation": {
            "args": [
              "sidecar-append-audit",
              "--audit",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "audit"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-specPath",
          "invocation": {
            "args": [
              "sidecar-append-audit",
              "--specPath",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "all-flags-success",
          "invocation": {
            "args": [
              "sidecar-append-audit",
              "--specPath",
              "$SPEC",
              "--audit",
              "{\"phase\":\"contract\",\"round\":1,\"side\":\"codex\",\"commands\":[{\"cmd\":\"npm test\",\"summary\":\"green\",\"kind\":\"verification\",\"exit_code\":0}]}"
            ],
            "stdin": "",
            "setup": "sidecar"
          },
          "covers": {
            "flags": [
              "audit",
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "empty"
            }
          }
        }
      ]
    },
    "sidecar-append-implement-dispatch": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "dispatch",
        "sliceId",
        "specPath"
      ],
      "exits": [],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "dispatch",
          "required": true,
          "value_type": "json"
        },
        {
          "name": "sliceId",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "specPath",
          "required": true,
          "value_type": "string"
        }
      ],
      "stdout_types": {},
      "exit_meanings": {},
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "sidecar-append-implement-dispatch"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-dispatch",
          "invocation": {
            "args": [
              "sidecar-append-implement-dispatch",
              "--dispatch",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "dispatch"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-sliceId",
          "invocation": {
            "args": [
              "sidecar-append-implement-dispatch",
              "--sliceId",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "sliceId"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-specPath",
          "invocation": {
            "args": [
              "sidecar-append-implement-dispatch",
              "--specPath",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "all-flags-success",
          "invocation": {
            "args": [
              "sidecar-append-implement-dispatch",
              "--specPath",
              "$SPEC",
              "--sliceId",
              "slice-1",
              "--dispatch",
              "{\"slice_id\":\"slice-1\",\"agent\":\"codex\",\"dispatched_at\":\"2026-01-01T00:00:00Z\",\"worktree\":\"/tmp/worktree\",\"outcome\":\"shipped\"}"
            ],
            "stdin": "",
            "setup": "sidecar"
          },
          "covers": {
            "flags": [
              "dispatch",
              "sliceId",
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "empty"
            }
          }
        }
      ]
    },
    "sidecar-append-round": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "allow-over-budget",
        "force-round",
        "headSha",
        "round",
        "specPath"
      ],
      "exits": [],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "allow-over-budget",
          "required": false,
          "value_type": "boolean"
        },
        {
          "name": "force-round",
          "required": false,
          "value_type": "boolean"
        },
        {
          "name": "headSha",
          "required": false,
          "value_type": "string"
        },
        {
          "name": "round",
          "required": true,
          "value_type": "number"
        },
        {
          "name": "specPath",
          "required": true,
          "value_type": "string"
        }
      ],
      "stdout_types": {},
      "exit_meanings": {},
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "sidecar-append-round"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-allow-over-budget",
          "invocation": {
            "args": [
              "sidecar-append-round",
              "--allow-over-budget"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "allow-over-budget"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-force-round",
          "invocation": {
            "args": [
              "sidecar-append-round",
              "--force-round"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "force-round"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-headSha",
          "invocation": {
            "args": [
              "sidecar-append-round",
              "--headSha",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "headSha"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-round",
          "invocation": {
            "args": [
              "sidecar-append-round",
              "--round",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "round"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-specPath",
          "invocation": {
            "args": [
              "sidecar-append-round",
              "--specPath",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "all-flags-success",
          "invocation": {
            "args": [
              "sidecar-append-round",
              "--specPath",
              "$SPEC",
              "--round",
              "{\"phase\":\"contract\",\"round\":1}",
              "--force-round",
              "--allow-over-budget",
              "--headSha",
              "abc"
            ],
            "stdin": "",
            "setup": "sidecar"
          },
          "covers": {
            "flags": [
              "allow-over-budget",
              "force-round",
              "headSha",
              "round",
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "empty"
            }
          }
        }
      ]
    },
    "sidecar-append-round-with-audits": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "allow-over-budget",
        "force-round",
        "headSha",
        "payload",
        "specPath"
      ],
      "exits": [
        2
      ],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "allow-over-budget",
          "required": false,
          "value_type": "boolean"
        },
        {
          "name": "force-round",
          "required": false,
          "value_type": "boolean"
        },
        {
          "name": "headSha",
          "required": false,
          "value_type": "string"
        },
        {
          "name": "payload",
          "required": true,
          "value_type": "json"
        },
        {
          "name": "specPath",
          "required": true,
          "value_type": "string"
        }
      ],
      "stdout_types": {},
      "exit_meanings": {
        "2": "usage or validation failure"
      },
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "sidecar-append-round-with-audits"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-allow-over-budget",
          "invocation": {
            "args": [
              "sidecar-append-round-with-audits",
              "--allow-over-budget"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "allow-over-budget"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-force-round",
          "invocation": {
            "args": [
              "sidecar-append-round-with-audits",
              "--force-round"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "force-round"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-headSha",
          "invocation": {
            "args": [
              "sidecar-append-round-with-audits",
              "--headSha",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "headSha"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-payload",
          "invocation": {
            "args": [
              "sidecar-append-round-with-audits",
              "--payload",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "payload"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-specPath",
          "invocation": {
            "args": [
              "sidecar-append-round-with-audits",
              "--specPath",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "all-flags-success",
          "invocation": {
            "args": [
              "sidecar-append-round-with-audits",
              "--specPath",
              "$SPEC",
              "--payload",
              "{\"audits\":[],\"round\":{\"phase\":\"contract\",\"round\":1}}",
              "--force-round",
              "--allow-over-budget",
              "--headSha",
              "abc"
            ],
            "stdin": "",
            "setup": "sidecar"
          },
          "covers": {
            "flags": [
              "allow-over-budget",
              "force-round",
              "headSha",
              "payload",
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "empty"
            }
          }
        }
      ]
    },
    "sidecar-get-autopilot": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "specPath"
      ],
      "exits": [],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "specPath",
          "required": true,
          "value_type": "string"
        }
      ],
      "stdout_types": {
        "json-present": {
          "halt_reason": "null",
          "current_phase": "string"
        }
      },
      "exit_meanings": {},
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "sidecar-get-autopilot"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-specPath",
          "invocation": {
            "args": [
              "sidecar-get-autopilot",
              "--specPath",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "empty-valid-sidecar",
          "invocation": {
            "args": [
              "sidecar-get-autopilot",
              "--specPath",
              "$SPEC"
            ],
            "stdin": "",
            "setup": "sidecar"
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "json-present",
          "invocation": {
            "args": [
              "sidecar-get-autopilot",
              "--specPath",
              "$SPEC"
            ],
            "stdin": "",
            "setup": "sidecar-autopilot"
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "json-present"
            }
          }
        }
      ]
    },
    "sidecar-get-dependency-graph": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "specPath"
      ],
      "exits": [],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "specPath",
          "required": true,
          "value_type": "string"
        }
      ],
      "stdout_types": {
        "json-present": {
          "digest": "string",
          "dag": {
            "type": "object",
            "required": {
              "ok": "boolean"
            },
            "additional": false
          },
          "persisted_at": "string"
        }
      },
      "exit_meanings": {},
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "sidecar-get-dependency-graph"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-specPath",
          "invocation": {
            "args": [
              "sidecar-get-dependency-graph",
              "--specPath",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "empty-valid-sidecar",
          "invocation": {
            "args": [
              "sidecar-get-dependency-graph",
              "--specPath",
              "$SPEC"
            ],
            "stdin": "",
            "setup": "sidecar"
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "json-present",
          "invocation": {
            "args": [
              "sidecar-get-dependency-graph",
              "--specPath",
              "$SPEC"
            ],
            "stdin": "",
            "setup": "sidecar-dependency-graph"
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "json-present"
            }
          }
        }
      ]
    },
    "sidecar-get-goals": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "specPath"
      ],
      "exits": [],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "specPath",
          "required": true,
          "value_type": "string"
        }
      ],
      "stdout_types": {
        "json-present": {
          "block": "string",
          "persisted_at": "string"
        }
      },
      "exit_meanings": {},
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "sidecar-get-goals"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-specPath",
          "invocation": {
            "args": [
              "sidecar-get-goals",
              "--specPath",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "empty-valid-sidecar",
          "invocation": {
            "args": [
              "sidecar-get-goals",
              "--specPath",
              "$SPEC"
            ],
            "stdin": "",
            "setup": "sidecar"
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "json-present",
          "invocation": {
            "args": [
              "sidecar-get-goals",
              "--specPath",
              "$SPEC"
            ],
            "stdin": "",
            "setup": "sidecar-goals"
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "json-present"
            }
          }
        }
      ]
    },
    "sidecar-has-audit": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "phase",
        "round",
        "side",
        "specPath"
      ],
      "exits": [
        2
      ],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "phase",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "round",
          "required": true,
          "value_type": "number"
        },
        {
          "name": "side",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "specPath",
          "required": true,
          "value_type": "string"
        }
      ],
      "stdout_types": {
        "all-flags-success": "boolean"
      },
      "exit_meanings": {
        "2": "usage or validation failure"
      },
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "sidecar-has-audit"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-phase",
          "invocation": {
            "args": [
              "sidecar-has-audit",
              "--phase",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "phase"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-round",
          "invocation": {
            "args": [
              "sidecar-has-audit",
              "--round",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "round"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-side",
          "invocation": {
            "args": [
              "sidecar-has-audit",
              "--side",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "side"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-specPath",
          "invocation": {
            "args": [
              "sidecar-has-audit",
              "--specPath",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "all-flags-success",
          "invocation": {
            "args": [
              "sidecar-has-audit",
              "--specPath",
              "$SPEC",
              "--phase",
              "contract",
              "--round",
              "1",
              "--side",
              "codex"
            ],
            "stdin": "",
            "setup": "sidecar"
          },
          "covers": {
            "flags": [
              "phase",
              "round",
              "side",
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "all-flags-success"
            }
          }
        }
      ]
    },
    "sidecar-has-executed-verification": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "phase",
        "round",
        "side",
        "specPath"
      ],
      "exits": [
        2
      ],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "phase",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "round",
          "required": true,
          "value_type": "number"
        },
        {
          "name": "side",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "specPath",
          "required": true,
          "value_type": "string"
        }
      ],
      "stdout_types": {
        "all-flags-success": "boolean"
      },
      "exit_meanings": {
        "2": "usage or validation failure"
      },
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "sidecar-has-executed-verification"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-phase",
          "invocation": {
            "args": [
              "sidecar-has-executed-verification",
              "--phase",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "phase"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-round",
          "invocation": {
            "args": [
              "sidecar-has-executed-verification",
              "--round",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "round"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-side",
          "invocation": {
            "args": [
              "sidecar-has-executed-verification",
              "--side",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "side"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-specPath",
          "invocation": {
            "args": [
              "sidecar-has-executed-verification",
              "--specPath",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "all-flags-success",
          "invocation": {
            "args": [
              "sidecar-has-executed-verification",
              "--specPath",
              "$SPEC",
              "--phase",
              "contract",
              "--round",
              "1",
              "--side",
              "codex"
            ],
            "stdin": "",
            "setup": "sidecar"
          },
          "covers": {
            "flags": [
              "phase",
              "round",
              "side",
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "all-flags-success"
            }
          }
        }
      ]
    },
    "sidecar-init": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "feature",
        "model",
        "reasoning",
        "specPath",
        "threadId"
      ],
      "exits": [],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "feature",
          "required": false,
          "value_type": "string"
        },
        {
          "name": "model",
          "required": false,
          "value_type": "string"
        },
        {
          "name": "reasoning",
          "required": false,
          "value_type": "string"
        },
        {
          "name": "specPath",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "threadId",
          "required": false,
          "value_type": "string"
        }
      ],
      "stdout_types": {
        "flag-specPath": {
          "version": "number",
          "model": "string",
          "reasoning_effort": "string",
          "created_at": "string",
          "thread_config": {
            "paired-reviewer": {
              "role": "string",
              "cli": "string",
              "model": "string",
              "effort": "string",
              "opened_at": "string"
            }
          },
          "rounds": {
            "type": "object[]",
            "items": {
              "type": "object",
              "required": {
                "phase": "string",
                "round": "number"
              },
              "optional": {
                "claude": "string",
                "claude_version": "string",
                "panel": {
                  "type": "object[]",
                  "items": {
                    "member_id": "string",
                    "cli": "string",
                    "model": "string",
                    "version": "string",
                    "status": "string",
                    "session": "string"
                  }
                },
                "codex": "string",
                "status": "string"
              },
              "additional": false
            }
          },
          "panel_roster": {
            "type": "object",
            "required": {},
            "optional": {
              "planning": {
                "type": "object[]",
                "items": {
                  "member_id": "string",
                  "cli": "string",
                  "model": "string",
                  "effort": "string"
                }
              },
              "review": {
                "type": "object[]",
                "items": {
                  "member_id": "string",
                  "cli": "string",
                  "model": "string",
                  "effort": "string"
                }
              }
            },
            "additional": false
          },
          "open_contentions": {
            "type": "object[]",
            "items": {
              "type": "object",
              "required": {},
              "additional": true
            }
          },
          "slice_reviews": {}
        },
        "all-flags-success": {
          "version": "number",
          "feature": "string",
          "codex_session": "string",
          "model": "string",
          "reasoning_effort": "string",
          "created_at": "string",
          "thread_config": {
            "paired-reviewer": {
              "role": "string",
              "cli": "string",
              "model": "string",
              "effort": "string",
              "opened_at": "string"
            }
          },
          "rounds": {
            "type": "object[]",
            "items": {
              "type": "object",
              "required": {
                "phase": "string",
                "round": "number"
              },
              "optional": {
                "claude": "string",
                "claude_version": "string",
                "panel": {
                  "type": "object[]",
                  "items": {
                    "member_id": "string",
                    "cli": "string",
                    "model": "string",
                    "version": "string",
                    "status": "string",
                    "session": "string"
                  }
                },
                "codex": "string",
                "status": "string"
              },
              "additional": false
            }
          },
          "open_contentions": {
            "type": "object[]",
            "items": {
              "type": "object",
              "required": {},
              "additional": true
            }
          },
          "slice_reviews": {},
          "panel_roster": {
            "type": "object",
            "required": {},
            "optional": {
              "planning": {
                "type": "object[]",
                "items": {
                  "member_id": "string",
                  "cli": "string",
                  "model": "string",
                  "effort": "string"
                }
              },
              "review": {
                "type": "object[]",
                "items": {
                  "member_id": "string",
                  "cli": "string",
                  "model": "string",
                  "effort": "string"
                }
              }
            },
            "additional": false
          }
        }
      },
      "exit_meanings": {},
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "sidecar-init"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-feature",
          "invocation": {
            "args": [
              "sidecar-init",
              "--feature",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "feature"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-model",
          "invocation": {
            "args": [
              "sidecar-init",
              "--model",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "model"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-reasoning",
          "invocation": {
            "args": [
              "sidecar-init",
              "--reasoning",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "reasoning"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-specPath",
          "invocation": {
            "args": [
              "sidecar-init",
              "--specPath",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "flag-specPath"
            }
          }
        },
        {
          "case": "flag-threadId",
          "invocation": {
            "args": [
              "sidecar-init",
              "--threadId",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "threadId"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "all-flags-success",
          "invocation": {
            "args": [
              "sidecar-init",
              "--specPath",
              "$SPEC",
              "--feature",
              "contract",
              "--threadId",
              "thread",
              "--model",
              "model",
              "--reasoning",
              "high"
            ],
            "stdin": "",
            "setup": "repo"
          },
          "covers": {
            "flags": [
              "feature",
              "model",
              "reasoning",
              "specPath",
              "threadId"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "all-flags-success"
            }
          }
        }
      ]
    },
    "sidecar-list-audits": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "phase",
        "round",
        "side",
        "specPath"
      ],
      "exits": [],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "phase",
          "required": false,
          "value_type": "string"
        },
        {
          "name": "round",
          "required": false,
          "value_type": "number"
        },
        {
          "name": "side",
          "required": false,
          "value_type": "string"
        },
        {
          "name": "specPath",
          "required": true,
          "value_type": "string"
        }
      ],
      "stdout_types": {
        "all-flags-success": {
          "type": "object[]",
          "items": {
            "type": "object",
            "required": {
              "phase": "string",
              "round": "number",
              "side": "string",
              "commands": {
                "type": "object[]",
                "items": {
                  "type": "object",
                  "required": {
                    "cmd": "string",
                    "summary": "string",
                    "kind": "string",
                    "exit_code": "number",
                    "ran_at": "string"
                  },
                  "optional": {
                    "selection": {
                      "type": "object",
                      "required": {
                        "mode": "string",
                        "ran": "number"
                      },
                      "optional": {
                        "fullyCovered": "boolean",
                        "uncovered": "json[]",
                        "exit": "number"
                      },
                      "additional": false
                    },
                    "attempts": "number",
                    "flaky": "boolean"
                  },
                  "additional": false
                }
              },
              "verdict_basis": "string|null",
              "appended_at": "string"
            },
            "optional": {
              "reviewed_sha": "string"
            },
            "additional": false
          }
        }
      },
      "exit_meanings": {},
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "sidecar-list-audits"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-phase",
          "invocation": {
            "args": [
              "sidecar-list-audits",
              "--phase",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "phase"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-round",
          "invocation": {
            "args": [
              "sidecar-list-audits",
              "--round",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "round"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-side",
          "invocation": {
            "args": [
              "sidecar-list-audits",
              "--side",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "side"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-specPath",
          "invocation": {
            "args": [
              "sidecar-list-audits",
              "--specPath",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "all-flags-success",
          "invocation": {
            "args": [
              "sidecar-list-audits",
              "--specPath",
              "$SPEC",
              "--phase",
              "contract",
              "--round",
              "1",
              "--side",
              "codex"
            ],
            "stdin": "",
            "setup": "sidecar-audit"
          },
          "covers": {
            "flags": [
              "phase",
              "round",
              "side",
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "all-flags-success"
            }
          }
        }
      ]
    },
    "sidecar-path": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "specPath"
      ],
      "exits": [],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "specPath",
          "required": true,
          "value_type": "string"
        }
      ],
      "stdout_types": {},
      "exit_meanings": {},
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "sidecar-path"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-specPath",
          "invocation": {
            "args": [
              "sidecar-path",
              "--specPath",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "text",
              "pattern": "^/.+\\.codex\\.json$"
            }
          }
        }
      ]
    },
    "sidecar-replay-context": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "specPath"
      ],
      "exits": [],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "specPath",
          "required": true,
          "value_type": "string"
        }
      ],
      "stdout_types": {
        "all-flags-success": {
          "feature": "string|null",
          "artifact": "string",
          "goals": "string|null",
          "rounds": {
            "type": "object[]",
            "items": {
              "type": "object",
              "required": {
                "phase": "string",
                "round": "number",
                "claude": "string",
                "codex": "string"
              },
              "additional": false
            }
          },
          "open_contentions": {
            "type": "object[]",
            "items": {
              "type": "object",
              "required": {},
              "additional": true
            }
          },
          "thread_rotations": {
            "type": "object[]",
            "items": {
              "old_thread_id": "string|null",
              "new_thread_id": "string",
              "role": "string",
              "reason": "string|null",
              "phase": "string|null",
              "round": "number|null",
              "rotated_at": "string"
            }
          }
        }
      },
      "exit_meanings": {},
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "sidecar-replay-context"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-specPath",
          "invocation": {
            "args": [
              "sidecar-replay-context",
              "--specPath",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "all-flags-success",
          "invocation": {
            "args": [
              "sidecar-replay-context",
              "--specPath",
              "$SPEC"
            ],
            "stdin": "",
            "setup": "sidecar-replay"
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "all-flags-success"
            }
          }
        }
      ]
    },
    "sidecar-requires-verification": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "phase"
      ],
      "exits": [],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "phase",
          "required": true,
          "value_type": "string"
        }
      ],
      "stdout_types": {
        "baseline-no-args": "boolean",
        "flag-phase": "boolean"
      },
      "exit_meanings": {},
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "sidecar-requires-verification"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "baseline-no-args"
            }
          }
        },
        {
          "case": "flag-phase",
          "invocation": {
            "args": [
              "sidecar-requires-verification",
              "--phase",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "phase"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "flag-phase"
            }
          }
        }
      ]
    },
    "sidecar-rotate-thread-id": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "newThreadId",
        "oldThreadId",
        "phase",
        "reason",
        "role",
        "round",
        "specPath",
        "threadConfig"
      ],
      "exits": [],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "newThreadId",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "oldThreadId",
          "required": false,
          "value_type": "string"
        },
        {
          "name": "phase",
          "required": false,
          "value_type": "string"
        },
        {
          "name": "reason",
          "required": false,
          "value_type": "string"
        },
        {
          "name": "role",
          "required": false,
          "value_type": "string"
        },
        {
          "name": "round",
          "required": false,
          "value_type": "number"
        },
        {
          "name": "specPath",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "threadConfig",
          "required": false,
          "value_type": "json"
        }
      ],
      "stdout_types": {},
      "exit_meanings": {},
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "sidecar-rotate-thread-id"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-newThreadId",
          "invocation": {
            "args": [
              "sidecar-rotate-thread-id",
              "--newThreadId",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "newThreadId"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-oldThreadId",
          "invocation": {
            "args": [
              "sidecar-rotate-thread-id",
              "--oldThreadId",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "oldThreadId"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-phase",
          "invocation": {
            "args": [
              "sidecar-rotate-thread-id",
              "--phase",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "phase"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-reason",
          "invocation": {
            "args": [
              "sidecar-rotate-thread-id",
              "--reason",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "reason"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-role",
          "invocation": {
            "args": [
              "sidecar-rotate-thread-id",
              "--role",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "role"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-round",
          "invocation": {
            "args": [
              "sidecar-rotate-thread-id",
              "--round",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "round"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-specPath",
          "invocation": {
            "args": [
              "sidecar-rotate-thread-id",
              "--specPath",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-threadConfig",
          "invocation": {
            "args": [
              "sidecar-rotate-thread-id",
              "--threadConfig",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "threadConfig"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "all-flags-success",
          "invocation": {
            "args": [
              "sidecar-rotate-thread-id",
              "--specPath",
              "$SPEC",
              "--role",
              "paired-reviewer",
              "--oldThreadId",
              "thread",
              "--newThreadId",
              "thread-2",
              "--reason",
              "session-not-found",
              "--phase",
              "contract",
              "--round",
              "1",
              "--threadConfig",
              "{\"role\":\"review\",\"cli\":\"codex\",\"model\":\"model\",\"effort\":\"high\"}"
            ],
            "stdin": "",
            "setup": "sidecar"
          },
          "covers": {
            "flags": [
              "newThreadId",
              "oldThreadId",
              "phase",
              "reason",
              "role",
              "round",
              "specPath",
              "threadConfig"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "empty"
            }
          }
        }
      ]
    },
    "sidecar-scan-stale": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "max-age-hours",
        "repoRoot"
      ],
      "exits": [],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "max-age-hours",
          "required": false,
          "value_type": "number"
        },
        {
          "name": "repoRoot",
          "required": false,
          "value_type": "string"
        }
      ],
      "stdout_types": {
        "baseline-no-args": {
          "type": "object[]",
          "items": {
            "sidecar_path": "string",
            "current_slice": "json",
            "current_phase": "json",
            "last_tick_at": "string|null",
            "idle_hours": "number",
            "plan_path": "json"
          }
        },
        "flag-max-age-hours": {
          "type": "object[]",
          "items": {
            "sidecar_path": "string",
            "current_slice": "json",
            "current_phase": "json",
            "last_tick_at": "string|null",
            "idle_hours": "number",
            "plan_path": "json"
          }
        },
        "flag-repoRoot": {
          "type": "object[]",
          "items": {
            "sidecar_path": "string",
            "current_slice": "json",
            "current_phase": "json",
            "last_tick_at": "string|null",
            "idle_hours": "number",
            "plan_path": "json"
          }
        }
      },
      "exit_meanings": {},
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "sidecar-scan-stale"
            ],
            "stdin": "",
            "setup": "stale-sidecar"
          },
          "covers": {
            "flags": [],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "baseline-no-args"
            }
          }
        },
        {
          "case": "flag-max-age-hours",
          "invocation": {
            "args": [
              "sidecar-scan-stale",
              "--max-age-hours",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "max-age-hours"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "flag-max-age-hours"
            }
          }
        },
        {
          "case": "flag-repoRoot",
          "invocation": {
            "args": [
              "sidecar-scan-stale",
              "--repoRoot",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "repoRoot"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "flag-repoRoot"
            }
          }
        }
      ]
    },
    "sidecar-set-autopilot": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "block",
        "specPath"
      ],
      "exits": [],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "block",
          "required": true,
          "value_type": "json"
        },
        {
          "name": "specPath",
          "required": true,
          "value_type": "string"
        }
      ],
      "stdout_types": {},
      "exit_meanings": {},
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "sidecar-set-autopilot"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-block",
          "invocation": {
            "args": [
              "sidecar-set-autopilot",
              "--block",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "block"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-specPath",
          "invocation": {
            "args": [
              "sidecar-set-autopilot",
              "--specPath",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "all-flags-success",
          "invocation": {
            "args": [
              "sidecar-set-autopilot",
              "--specPath",
              "$SPEC",
              "--block",
              "{\"current_phase\":\"contract\"}"
            ],
            "stdin": "",
            "setup": "sidecar"
          },
          "covers": {
            "flags": [
              "block",
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "empty"
            }
          }
        }
      ]
    },
    "sidecar-set-dependency-graph": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "graph",
        "specPath"
      ],
      "exits": [],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "graph",
          "required": true,
          "value_type": "json"
        },
        {
          "name": "specPath",
          "required": true,
          "value_type": "string"
        }
      ],
      "stdout_types": {},
      "exit_meanings": {},
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "sidecar-set-dependency-graph"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-graph",
          "invocation": {
            "args": [
              "sidecar-set-dependency-graph",
              "--graph",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "graph"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-specPath",
          "invocation": {
            "args": [
              "sidecar-set-dependency-graph",
              "--specPath",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "all-flags-success",
          "invocation": {
            "args": [
              "sidecar-set-dependency-graph",
              "--specPath",
              "$SPEC",
              "--graph",
              "{\"digest\":\"abc\",\"dag\":{}}"
            ],
            "stdin": "",
            "setup": "sidecar"
          },
          "covers": {
            "flags": [
              "graph",
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "empty"
            }
          }
        }
      ]
    },
    "sidecar-set-goals": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "block",
        "specPath"
      ],
      "exits": [
        2
      ],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "block",
          "required": true,
          "value_type": "json"
        },
        {
          "name": "specPath",
          "required": true,
          "value_type": "string"
        }
      ],
      "stdout_types": {},
      "exit_meanings": {
        "2": "usage or validation failure"
      },
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "sidecar-set-goals"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-block",
          "invocation": {
            "args": [
              "sidecar-set-goals",
              "--block",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "block"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-specPath",
          "invocation": {
            "args": [
              "sidecar-set-goals",
              "--specPath",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "all-flags-success",
          "invocation": {
            "args": [
              "sidecar-set-goals",
              "--specPath",
              "$SPEC",
              "--block",
              "<<<GOALS>>>contract<<<END_GOALS>>>"
            ],
            "stdin": "",
            "setup": "sidecar"
          },
          "covers": {
            "flags": [
              "block",
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "empty"
            }
          }
        }
      ]
    },
    "sidecar-set-implement-bootstrap": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "bootstrap",
        "sliceId",
        "specPath"
      ],
      "exits": [],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "bootstrap",
          "required": true,
          "value_type": "json"
        },
        {
          "name": "sliceId",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "specPath",
          "required": true,
          "value_type": "string"
        }
      ],
      "stdout_types": {},
      "exit_meanings": {},
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "sidecar-set-implement-bootstrap"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-bootstrap",
          "invocation": {
            "args": [
              "sidecar-set-implement-bootstrap",
              "--bootstrap",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "bootstrap"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-sliceId",
          "invocation": {
            "args": [
              "sidecar-set-implement-bootstrap",
              "--sliceId",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "sliceId"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-specPath",
          "invocation": {
            "args": [
              "sidecar-set-implement-bootstrap",
              "--specPath",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "all-flags-success",
          "invocation": {
            "args": [
              "sidecar-set-implement-bootstrap",
              "--specPath",
              "$SPEC",
              "--sliceId",
              "slice-1",
              "--bootstrap",
              "{\"symlinks\":[],\"completed_at\":\"2026-01-01T00:00:00Z\"}"
            ],
            "stdin": "",
            "setup": "sidecar"
          },
          "covers": {
            "flags": [
              "bootstrap",
              "sliceId",
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "empty"
            }
          }
        }
      ]
    },
    "sidecar-set-implement-meta": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "meta",
        "sliceId",
        "specPath"
      ],
      "exits": [],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "meta",
          "required": true,
          "value_type": "json"
        },
        {
          "name": "sliceId",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "specPath",
          "required": true,
          "value_type": "string"
        }
      ],
      "stdout_types": {},
      "exit_meanings": {},
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "sidecar-set-implement-meta"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-meta",
          "invocation": {
            "args": [
              "sidecar-set-implement-meta",
              "--meta",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "meta"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-sliceId",
          "invocation": {
            "args": [
              "sidecar-set-implement-meta",
              "--sliceId",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "sliceId"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-specPath",
          "invocation": {
            "args": [
              "sidecar-set-implement-meta",
              "--specPath",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "all-flags-success",
          "invocation": {
            "args": [
              "sidecar-set-implement-meta",
              "--specPath",
              "$SPEC",
              "--sliceId",
              "slice-1",
              "--meta",
              "{\"preferred_implementer\":\"codex\",\"fallback_implementer\":\"sonnet\",\"parallel_group\":null,\"parallel_suppressed_reason\":null,\"worktree\":\"/tmp/worktree\"}"
            ],
            "stdin": "",
            "setup": "sidecar"
          },
          "covers": {
            "flags": [
              "meta",
              "sliceId",
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "empty"
            }
          }
        }
      ]
    },
    "sidecar-set-live-verification": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "block",
        "sliceId",
        "specPath"
      ],
      "exits": [],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "block",
          "required": true,
          "value_type": "json"
        },
        {
          "name": "sliceId",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "specPath",
          "required": true,
          "value_type": "string"
        }
      ],
      "stdout_types": {},
      "exit_meanings": {},
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "sidecar-set-live-verification"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-block",
          "invocation": {
            "args": [
              "sidecar-set-live-verification",
              "--block",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "block"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-sliceId",
          "invocation": {
            "args": [
              "sidecar-set-live-verification",
              "--sliceId",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "sliceId"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-specPath",
          "invocation": {
            "args": [
              "sidecar-set-live-verification",
              "--specPath",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "all-flags-success",
          "invocation": {
            "args": [
              "sidecar-set-live-verification",
              "--specPath",
              "$SPEC",
              "--sliceId",
              "slice-1",
              "--block",
              "{\"shipped\":true}"
            ],
            "stdin": "",
            "setup": "sidecar"
          },
          "covers": {
            "flags": [
              "block",
              "sliceId",
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "empty"
            }
          }
        }
      ]
    },
    "sidecar-set-panel-roster": {
      "stability": "stable",
      "since": "0.19.0",
      "flags": [
        "phase",
        "roster",
        "specPath"
      ],
      "exits": [
        1,
        2
      ],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "phase",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "roster",
          "required": true,
          "value_type": "json"
        },
        {
          "name": "specPath",
          "required": true,
          "value_type": "string"
        }
      ],
      "stdout_types": {},
      "exit_meanings": {
        "1": "roster validation or persisted-roster conflict",
        "2": "usage or malformed JSON"
      },
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "sidecar-set-panel-roster"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-phase",
          "invocation": {
            "args": [
              "sidecar-set-panel-roster",
              "--phase",
              "planning"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "phase"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-roster",
          "invocation": {
            "args": [
              "sidecar-set-panel-roster",
              "--roster",
              "[]"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "roster"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-specPath",
          "invocation": {
            "args": [
              "sidecar-set-panel-roster",
              "--specPath",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "invalid-empty-roster",
          "invocation": {
            "args": [
              "sidecar-set-panel-roster",
              "--specPath",
              "$SPEC",
              "--phase",
              "planning",
              "--roster",
              "[]"
            ],
            "stdin": "",
            "setup": "sidecar"
          },
          "covers": {
            "flags": [],
            "exits": [
              1
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "malformed-roster-json",
          "invocation": {
            "args": [
              "sidecar-set-panel-roster",
              "--specPath",
              "$SPEC",
              "--phase",
              "planning",
              "--roster",
              "not-json"
            ],
            "stdin": "",
            "setup": "sidecar"
          },
          "covers": {
            "flags": [],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "all-flags-success",
          "invocation": {
            "args": [
              "sidecar-set-panel-roster",
              "--specPath",
              "$SPEC",
              "--phase",
              "planning",
              "--roster",
              "[{\"member_id\":\"codex:model\",\"cli\":\"codex\",\"model\":\"model\",\"effort\":\"high\"}]"
            ],
            "stdin": "",
            "setup": "sidecar"
          },
          "covers": {
            "flags": [
              "phase",
              "roster",
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "empty"
            }
          }
        }
      ]
    },
    "sidecar-set-phase": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "phase",
        "sliceId",
        "specPath",
        "state"
      ],
      "exits": [],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "phase",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "sliceId",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "specPath",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "state",
          "required": true,
          "value_type": "json"
        }
      ],
      "stdout_types": {},
      "exit_meanings": {},
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "sidecar-set-phase"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-phase",
          "invocation": {
            "args": [
              "sidecar-set-phase",
              "--phase",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "phase"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-sliceId",
          "invocation": {
            "args": [
              "sidecar-set-phase",
              "--sliceId",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "sliceId"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-specPath",
          "invocation": {
            "args": [
              "sidecar-set-phase",
              "--specPath",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-state",
          "invocation": {
            "args": [
              "sidecar-set-phase",
              "--state",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "state"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "all-flags-success",
          "invocation": {
            "args": [
              "sidecar-set-phase",
              "--specPath",
              "$SPEC",
              "--sliceId",
              "slice-1",
              "--phase",
              "contract",
              "--state",
              "{\"status\":\"done\"}"
            ],
            "stdin": "",
            "setup": "sidecar"
          },
          "covers": {
            "flags": [
              "phase",
              "sliceId",
              "specPath",
              "state"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "empty"
            }
          }
        }
      ]
    },
    "sidecar-set-slice": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "sliceId",
        "specPath",
        "state"
      ],
      "exits": [],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "sliceId",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "specPath",
          "required": true,
          "value_type": "string"
        },
        {
          "name": "state",
          "required": true,
          "value_type": "json"
        }
      ],
      "stdout_types": {},
      "exit_meanings": {},
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "sidecar-set-slice"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-sliceId",
          "invocation": {
            "args": [
              "sidecar-set-slice",
              "--sliceId",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "sliceId"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-specPath",
          "invocation": {
            "args": [
              "sidecar-set-slice",
              "--specPath",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-state",
          "invocation": {
            "args": [
              "sidecar-set-slice",
              "--state",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "state"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "all-flags-success",
          "invocation": {
            "args": [
              "sidecar-set-slice",
              "--specPath",
              "$SPEC",
              "--sliceId",
              "slice-1",
              "--state",
              "{\"status\":\"done\"}"
            ],
            "stdin": "",
            "setup": "sidecar"
          },
          "covers": {
            "flags": [
              "sliceId",
              "specPath",
              "state"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "empty"
            }
          }
        }
      ]
    },
    "sidecar-show": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "specPath"
      ],
      "exits": [],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "specPath",
          "required": true,
          "value_type": "string"
        }
      ],
      "stdout_types": {
        "all-flags-success": {
          "version": "number",
          "feature": "string",
          "codex_session": "string",
          "model": "string",
          "reasoning_effort": "string",
          "created_at": "string",
          "thread_config": {
            "paired-reviewer": {
              "role": "string",
              "cli": "string",
              "model": "string",
              "effort": "string",
              "opened_at": "string"
            }
          },
          "rounds": {
            "type": "object[]",
            "items": {
              "type": "object",
              "required": {
                "phase": "string",
                "round": "number"
              },
              "optional": {
                "claude": "string",
                "claude_version": "string",
                "panel": {
                  "type": "object[]",
                  "items": {
                    "member_id": "string",
                    "cli": "string",
                    "model": "string",
                    "version": "string",
                    "status": "string",
                    "session": "string"
                  }
                },
                "codex": "string",
                "status": "string"
              },
              "additional": false
            }
          },
          "open_contentions": {
            "type": "object[]",
            "items": {
              "type": "object",
              "required": {},
              "additional": true
            }
          },
          "slice_reviews": {},
          "panel_roster": {
            "type": "object",
            "required": {},
            "optional": {
              "planning": {
                "type": "object[]",
                "items": {
                  "member_id": "string",
                  "cli": "string",
                  "model": "string",
                  "effort": "string"
                }
              },
              "review": {
                "type": "object[]",
                "items": {
                  "member_id": "string",
                  "cli": "string",
                  "model": "string",
                  "effort": "string"
                }
              }
            },
            "additional": false
          },
          "role_sessions": {
            "paired-reviewer": "string"
          },
          "migrations": {
            "type": "object[]",
            "items": {
              "from_schema": "string",
              "to_schema": "string",
              "action": "string",
              "migrated_at": "string"
            }
          },
          "thread_rotations": {
            "type": "object[]",
            "items": {
              "old_thread_id": "string|null",
              "new_thread_id": "string",
              "role": "string",
              "reason": "string|null",
              "phase": "string|null",
              "round": "number|null",
              "rotated_at": "string"
            }
          }
        }
      },
      "exit_meanings": {},
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "sidecar-show"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-specPath",
          "invocation": {
            "args": [
              "sidecar-show",
              "--specPath",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "all-flags-success",
          "invocation": {
            "args": [
              "sidecar-show",
              "--specPath",
              "$SPEC"
            ],
            "stdin": "",
            "setup": "sidecar-replay"
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "all-flags-success"
            }
          }
        }
      ]
    },
    "sidecar-thread-id": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "role",
        "specPath"
      ],
      "exits": [],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "role",
          "required": false,
          "value_type": "string"
        },
        {
          "name": "specPath",
          "required": true,
          "value_type": "string"
        }
      ],
      "stdout_types": {},
      "exit_meanings": {},
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "sidecar-thread-id"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-role",
          "invocation": {
            "args": [
              "sidecar-thread-id",
              "--role",
              "__contract__"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "role"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-specPath",
          "invocation": {
            "args": [
              "sidecar-thread-id",
              "--specPath",
              "$TMP"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 1,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "empty-role",
          "invocation": {
            "args": [
              "sidecar-thread-id",
              "--specPath",
              "$SPEC",
              "--role",
              "contract-unset"
            ],
            "stdin": "",
            "setup": "sidecar"
          },
          "covers": {
            "flags": [
              "role",
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "text-present",
          "invocation": {
            "args": [
              "sidecar-thread-id",
              "--specPath",
              "$SPEC",
              "--role",
              "paired-reviewer"
            ],
            "stdin": "",
            "setup": "sidecar"
          },
          "covers": {
            "flags": [
              "role",
              "specPath"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "text",
              "exact": "thread"
            }
          }
        }
      ]
    },
    "validation-parse": {
      "stability": "stable",
      "since": "0.18.0",
      "flags": [
        "tier"
      ],
      "exits": [
        0,
        2
      ],
      "stdoutKeys": [
        "coverage",
        "tier"
      ],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "tier",
          "required": false,
          "value_type": "string"
        }
      ],
      "stdout_types": {
        "valid-standard-json": {
          "tier": "string",
          "coverage": {
            "happy": "string",
            "edge.zero-null-empty": "string",
            "edge.boundary": "string",
            "edge.large-input": "string",
            "edge.concurrent": "string",
            "edge.adversarial": "string",
            "fail.dependency": "string",
            "fail.malformed-input": "string",
            "fail.exception-path": "string",
            "integration.cross-module": "string",
            "stress.scale": "string",
            "perf.slo": "string",
            "compat.breaking": "string"
          }
        }
      },
      "exit_meanings": {
        "0": "success",
        "2": "usage or validation failure"
      },
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "validation-parse"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "flag-tier",
          "invocation": {
            "args": [
              "validation-parse",
              "--tier",
              "standard"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [
              "tier"
            ],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "valid-standard-json",
          "invocation": {
            "args": [
              "validation-parse",
              "--tier",
              "standard"
            ],
            "stdin": "[\"tier: standard\",\"happy: c\",\"edge.zero-null-empty: c\",\"edge.boundary: c\",\"edge.large-input: c\",\"edge.concurrent: c\",\"edge.adversarial: c\",\"fail.dependency: c\",\"fail.malformed-input: c\",\"fail.exception-path: c\",\"integration.cross-module: c\",\"stress.scale: not triggered\",\"perf.slo: not triggered\",\"compat.breaking: not triggered\"]"
          },
          "covers": {
            "flags": [
              "tier"
            ],
            "exits": [
              0
            ],
            "stdoutKeys": [
              "coverage",
              "tier"
            ]
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "valid-standard-json"
            }
          }
        }
      ]
    },
    "worktree-reap": {
      "stability": "stable",
      "since": "0.19.0",
      "flags": [
        "apply",
        "repoRoot"
      ],
      "exits": [
        2
      ],
      "stdoutKeys": [],
      "unsupported": [],
      "flag_contract": [
        {
          "name": "apply",
          "required": false,
          "value_type": "boolean"
        },
        {
          "name": "repoRoot",
          "required": true,
          "value_type": "string"
        }
      ],
      "stdout_types": {
        "dry-run": {
          "apply": "boolean",
          "entries": {
            "type": "object[]",
            "items": {
              "path": "string",
              "registered": "boolean",
              "class": "string",
              "kind": "string|null",
              "age_ms": "number|null",
              "keep": "string[]",
              "removed": "boolean"
            }
          }
        },
        "apply": {
          "apply": "boolean",
          "entries": {
            "type": "object[]",
            "items": {
              "path": "string",
              "registered": "boolean",
              "class": "string",
              "kind": "string|null",
              "age_ms": "number|null",
              "keep": "string[]",
              "removed": "boolean"
            }
          }
        }
      },
      "exit_meanings": {
        "2": "usage error"
      },
      "cases": [
        {
          "case": "baseline-no-args",
          "invocation": {
            "args": [
              "worktree-reap"
            ],
            "stdin": ""
          },
          "covers": {
            "flags": [],
            "exits": [
              2
            ],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 2,
            "stdout": {
              "kind": "empty"
            }
          }
        },
        {
          "case": "dry-run",
          "invocation": {
            "args": [
              "worktree-reap",
              "--repoRoot",
              "$REPO"
            ],
            "stdin": "",
            "setup": "repo"
          },
          "covers": {
            "flags": [
              "repoRoot"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "dry-run",
              "field_values": {
                "apply": false
              }
            }
          }
        },
        {
          "case": "apply",
          "invocation": {
            "args": [
              "worktree-reap",
              "--apply",
              "--repoRoot",
              "$REPO"
            ],
            "stdin": "",
            "setup": "repo"
          },
          "covers": {
            "flags": [
              "apply",
              "repoRoot"
            ],
            "exits": [],
            "stdoutKeys": []
          },
          "expect": {
            "exit": 0,
            "stdout": {
              "kind": "json",
              "schema": "apply",
              "field_values": {
                "apply": true
              }
            }
          }
        }
      ]
    }
  },
  "closure": [
    "lib/codex-bridge/active-anchor.js",
    "lib/codex-bridge/availability/cache.js",
    "lib/codex-bridge/availability/detector.js",
    "lib/codex-bridge/availability/prober.js",
    "lib/codex-bridge/checkout-markers.js",
    "lib/codex-bridge/checkout-reaper.js",
    "lib/codex-bridge/cli-harness/adapters/agy.js",
    "lib/codex-bridge/cli-harness/adapters/claude-cli.js",
    "lib/codex-bridge/cli-harness/adapters/codex.js",
    "lib/codex-bridge/cli-harness/adapters/ollama.js",
    "lib/codex-bridge/cli-harness/adapters/registry.js",
    "lib/codex-bridge/cli-harness/harness.js",
    "lib/codex-bridge/cli-harness/normalizer.js",
    "lib/codex-bridge/cli-harness/process-lifecycle.js",
    "lib/codex-bridge/cli.js",
    "lib/codex-bridge/halt-envelope.js",
    "lib/codex-bridge/honest-reporting-marker.js",
    "lib/codex-bridge/implementer/member-id.js",
    "lib/codex-bridge/implementer/secret-redaction.js",
    "lib/codex-bridge/live-validation-coverage.js",
    "lib/codex-bridge/mailbox.js",
    "lib/codex-bridge/models.js",
    "lib/codex-bridge/project-config.js",
    "lib/codex-bridge/review-panel-run.js",
    "lib/codex-bridge/review-panel.js",
    "lib/codex-bridge/reviewer-thread.js",
    "lib/codex-bridge/role-routing/cli-clients.js",
    "lib/codex-bridge/role-routing/config-loader.js",
    "lib/codex-bridge/role-routing/errors.js",
    "lib/codex-bridge/role-routing/recommendations.js",
    "lib/codex-bridge/scenario-validator.js",
    "lib/codex-bridge/sidecar.js",
    "lib/codex-bridge/skip-frontmatter.js",
    "lib/codex-bridge/validation-coverage.js",
    "lib/codex-bridge/verdict.js",
    "lib/codex-bridge/worktree.js",
    "scripts/lib/process-ownership.mjs"
  ],
  "module_digest": {
    "lib/codex-bridge/active-anchor.js": "sha256:efeec4ebb5735a634b5c2314a0ab3e4812d31a0446df9857bafbcca04fb908a5",
    "lib/codex-bridge/availability/cache.js": "sha256:014aec22d96719353a2ef898b15732bad701ca15196ebc9a9ef6c74ba41a5125",
    "lib/codex-bridge/availability/detector.js": "sha256:9d640898dba68db1cdccca087e410db5a15e36bf182cbc9f4d604e6fe77a7ea6",
    "lib/codex-bridge/availability/prober.js": "sha256:dd791a5dc8e6e83015de086f5012b2bac9491c5fdf30a77d927556f120bafbaa",
    "lib/codex-bridge/checkout-markers.js": "sha256:a37c9fa77bfab898f7abb25551c5057912c53fb1b6b140b8f798425906b7cf48",
    "lib/codex-bridge/checkout-reaper.js": "sha256:36365aae8bc77633fd2359e7525c3759cc3b87ea5ed331b97b47abe3c8e72a64",
    "lib/codex-bridge/cli-harness/adapters/agy.js": "sha256:382a4b360e58045da4f9cc6f7b0b8d5b37d9a8b8d365f2b7e1a045a180f29b81",
    "lib/codex-bridge/cli-harness/adapters/claude-cli.js": "sha256:4e243005f48bf9616ab8c0da127017733cdae932eaee1d1d4ccdd04bdd0ac198",
    "lib/codex-bridge/cli-harness/adapters/codex.js": "sha256:a92a130d27d669d627b8a756a711eafdd1b74ae08b6fb88d1190691193e41337",
    "lib/codex-bridge/cli-harness/adapters/ollama.js": "sha256:dd36f0f241ba63c8254dba2966b49bab44498e689e3e416da5d6586fb80e1402",
    "lib/codex-bridge/cli-harness/adapters/registry.js": "sha256:bc72918156350df68b0c9e07837f992fde4dd458878bd0128d2ff4c22a0b9817",
    "lib/codex-bridge/cli-harness/harness.js": "sha256:486f95ace75081d35c5d5bb9a1a2fdb6b6c55408004f5bf5c3d30a49148a3480",
    "lib/codex-bridge/cli-harness/normalizer.js": "sha256:58fbeb5440487f14f1f11ca7906e157d034dbada63449ac68875ce2bb4c0444d",
    "lib/codex-bridge/cli-harness/process-lifecycle.js": "sha256:d35fef32b503bc5e40f7f58e27e0599c07f96d164f36f25cd52425aae5dac978",
    "lib/codex-bridge/cli.js": "sha256:d73b2ecee9e785ff5157a9b47bdafa5f2d0d96846737da4943ae9baf62df7a43",
    "lib/codex-bridge/halt-envelope.js": "sha256:daca46b4d7f6a5b1c6c0055751254d1bbcf66eefe711d8e5cb4c3a944a38d731",
    "lib/codex-bridge/honest-reporting-marker.js": "sha256:a8b076f88fb440f6b0b0508f54ec16873f3d83dc46b4cee81f7c71416e89d2f2",
    "lib/codex-bridge/implementer/member-id.js": "sha256:3dab9201d15462172d8e37247838c1c49329055caf97707a0704b711e1d21f94",
    "lib/codex-bridge/implementer/secret-redaction.js": "sha256:c5e57d3a3a8513cb38fc1af169534806ef889e9dae7097d298a1c8d5d019e035",
    "lib/codex-bridge/live-validation-coverage.js": "sha256:a7b8abbc4463b8d9a43ca404baae6663e00216174f51edd26334d2f8f9a5bc1e",
    "lib/codex-bridge/mailbox.js": "sha256:786e519d904e1176f12227e403af8107071e4594b0d9178d64e5627044fd1a06",
    "lib/codex-bridge/models.js": "sha256:2f5e000fded6907ac318e6c6e6f8d1a5eea023a5b200e4689fffa3b6cbcdcff2",
    "lib/codex-bridge/project-config.js": "sha256:3840f68021ffc20f8add89442e41906265d08bd5ec3fdd02f9651bacb0caf445",
    "lib/codex-bridge/review-panel-run.js": "sha256:79554912d762f683dd0ad563ccca842b34a31374e1fa7a955b3ab690d68671e4",
    "lib/codex-bridge/review-panel.js": "sha256:1f1f61f9acc74ef63996cdc6ca69d2a16ee2a5f32cdce409b07c9905af5cbf0e",
    "lib/codex-bridge/reviewer-thread.js": "sha256:269ec5d97edc48c4e614f712f4bddcf7c5896fc8b024a67618fc0eb1f4cfc945",
    "lib/codex-bridge/role-routing/cli-clients.js": "sha256:8c8b9ecca0595566c342cc81445f55ab5fe9b749cfbb9538ec14939b6d4b0033",
    "lib/codex-bridge/role-routing/config-loader.js": "sha256:e8e773d8a0f58bb8a3106e73515ff723cca6cf24664c4a43ced4747318023b00",
    "lib/codex-bridge/role-routing/errors.js": "sha256:2f79bc7d21eb6d5c0670b853a8e840437c6160f196ce0f3063f1e69fc6235cb9",
    "lib/codex-bridge/role-routing/recommendations.js": "sha256:8ede395041e25fdd1b5ec704cbd152d7ee3e7177bcda48bbd1646068ba2357ef",
    "lib/codex-bridge/scenario-validator.js": "sha256:2326e5d1b9c8f1ba9e78a9b2291dcca21211b7060a26141849f5c593a410c5f1",
    "lib/codex-bridge/sidecar.js": "sha256:4c8f0e545a22644330f864ccb84470a91e6c89626435e66ea2e1cd4cef5524d4",
    "lib/codex-bridge/skip-frontmatter.js": "sha256:c4b1fc93c1f38c5c784865525f3a40f6a522571bf52a063b613ce02e261d8b2a",
    "lib/codex-bridge/validation-coverage.js": "sha256:1bcfb4024aa0b236ce4119695be4a330760355b8ab8caba93ccc04d94f4fee1d",
    "lib/codex-bridge/verdict.js": "sha256:dcd1b71ea769990a84ad2b1af39837628a33651c6ce1e08144e795afb93d1cb1",
    "lib/codex-bridge/worktree.js": "sha256:d98507a7a5850f49db90d2421e3b4d59d1de8853f80b75a1449eb20831ac69f6",
    "scripts/lib/process-ownership.mjs": "sha256:08769b406b72e1458da9f8e8e92e1ca2fcccc13d06fd78666ba5be41f58ab802"
  },
  "input_digest": {
    "lib/codex-bridge/cli-clients/agy.json": "sha256:b1ed7727d9dc0e80a457b9ac1dbec752dec8e7cbd7005442eb900d94962b83a4",
    "lib/codex-bridge/cli-clients/claude-cli.json": "sha256:1e4a6a59bd66c643d0e5b822c33c144b4394aba667f92d116a2c3ab38571326f",
    "lib/codex-bridge/cli-clients/claude.json": "sha256:f27bd9fa19a81fca71209b8a775933296cdfcd5941326d07b7cc1e9820160abb",
    "lib/codex-bridge/cli-clients/codex.json": "sha256:76c0a1669e30496dde1779f9756788d7916370e986c7709d6ae3224e7cce31a9",
    "lib/codex-bridge/cli-clients/ollama.json": "sha256:7d95e72bb9a72ff30b8fc0f8c2e7dfc278bd867ec2b1b31ad6052f1157292984",
    "lib/codex-bridge/cli-clients/qwen.json": "sha256:6ba38b51b5454785584db5852473fa0a0f35fe7c1cb532a4a42750a3390c837d"
  }
}
```

```json public-api:wrapper
{
  "stability": "stable",
  "since": "0.18.0",
  "flags": [
    {
      "name": "--model-role",
      "value_type": "string"
    },
    {
      "name": "--repo-root",
      "value_type": "path"
    },
    {
      "name": "--cwd",
      "value_type": "path"
    },
    {
      "name": "--",
      "value_type": "separator"
    }
  ],
  "exit_codes": [
    0,
    64,
    74,
    78,
    129,
    130,
    143,
    "child-passthrough"
  ],
  "status_file": {
    "required_fields": [
      "completed_at",
      "exit_code",
      "signal",
      "started_at",
      "state"
    ],
    "optional_fields": [
      "cli",
      "cwd",
      "effort",
      "error",
      "model",
      "model_role"
    ],
    "types": {
      "state": "started|exited",
      "exit_code": "number|null",
      "signal": "string|null",
      "started_at": "string",
      "completed_at": "string|null",
      "model_role": "string",
      "model": "string",
      "effort": "string",
      "error": "string",
      "cli": "string",
      "cwd": "string"
    },
    "lifecycle": [
      "started",
      "exited"
    ]
  }
}
```

```json public-api:doctor
{
  "stability": "stable",
  "since": "0.18.0",
  "flag": "--json",
  "exit": {
    "no_fail": 0,
    "any_fail": 1
  },
  "json_envelope": {
    "keys": [
      "availability",
      "checks",
      "summary"
    ],
    "check_fields": {
      "status": "pass|warn|fail",
      "name": "string",
      "detail": "string",
      "fix": "string|null"
    },
    "types": {
      "summary": {
        "pass": "number",
        "warn": "number",
        "fail": "number"
      },
      "checks": {
        "type": "object[]",
        "items": {
          "status": "string",
          "name": "string",
          "detail": "string",
          "fix": "string|null"
        }
      },
      "availability": {
        "type": "object|null",
        "required": {},
        "additional": true
      }
    }
  },
  "check_names": [
    "platform",
    "node",
    "codex-cli",
    "codex-auth",
    "git",
    "vendored-deps",
    "bridge-cli",
    "hooks",
    "project-state-dir",
    "models",
    "codex-transport",
    "review-panel",
    "worktrees"
  ],
  "human": {
    "one_line_per_check": true,
    "status_prefixes": [
      "PASS",
      "WARN",
      "FAIL"
    ],
    "wording_stable": false
  }
}
```

```json public-api:project-config
{
  "stability": "stable",
  "since": "0.18.0",
  "schema": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "required": [
      "version",
      "app",
      "live_verification"
    ],
    "properties": {
      "version": {
        "not": {
          "type": "null"
        }
      },
      "app": {
        "type": "object",
        "required": [
          "type"
        ],
        "properties": {
          "type": {
            "enum": [
              "web",
              "desktop",
              "mobile",
              "cli",
              "library"
            ]
          }
        },
        "additionalProperties": true
      },
      "live_verification": {
        "anyOf": [
          {
            "type": "array"
          },
          {
            "type": "object",
            "properties": {
              "default": {},
              "skip_reason": {},
              "cleanup": {
                "anyOf": [
                  {
                    "type": "object"
                  },
                  {
                    "type": "array"
                  },
                  {
                    "enum": [
                      null,
                      false,
                      0,
                      ""
                    ]
                  }
                ]
              },
              "setup": {
                "anyOf": [
                  {
                    "type": "object"
                  },
                  {
                    "type": "array"
                  },
                  {
                    "enum": [
                      null,
                      false,
                      0,
                      ""
                    ]
                  }
                ]
              },
              "logs": {
                "anyOf": [
                  {
                    "type": "object"
                  },
                  {
                    "type": "array"
                  },
                  {
                    "enum": [
                      null,
                      false,
                      0,
                      ""
                    ]
                  }
                ]
              },
              "takeover": {
                "anyOf": [
                  {
                    "type": "object",
                    "properties": {
                      "mode": {
                        "enum": [
                          "confirm_each_phase_e",
                          "scheduled_window"
                        ]
                      },
                      "scheduled_windows": {
                        "anyOf": [
                          {
                            "type": "array",
                            "items": {
                              "anyOf": [
                                {
                                  "type": "object",
                                  "properties": {
                                    "start": {
                                      "$ref": "#/$defs/window_time"
                                    },
                                    "end": {
                                      "$ref": "#/$defs/window_time"
                                    }
                                  },
                                  "additionalProperties": true
                                },
                                {
                                  "anyOf": [
                                    {
                                      "type": "string"
                                    },
                                    {
                                      "type": "number"
                                    },
                                    {
                                      "type": "boolean"
                                    },
                                    {
                                      "type": "array"
                                    }
                                  ]
                                }
                              ]
                            }
                          },
                          {
                            "not": {
                              "type": "array"
                            }
                          }
                        ]
                      }
                    },
                    "additionalProperties": true
                  },
                  {
                    "type": "array"
                  },
                  {
                    "enum": [
                      null,
                      false,
                      0,
                      ""
                    ]
                  }
                ]
              }
            },
            "additionalProperties": true
          }
        ]
      },
      "models": {
        "anyOf": [
          {
            "type": "null"
          },
          {
            "type": "object",
            "propertyNames": {
              "enum": [
                "planning",
                "review",
                "implement",
                "implement_fallback"
              ]
            },
            "additionalProperties": {
              "type": "object",
              "properties": {
                "cli": {
                  "enum": [
                    "codex",
                    "agy"
                  ]
                },
                "model": {
                  "type": "string",
                  "minLength": 1,
                  "pattern": "^[A-Za-z0-9._-]+$"
                },
                "effort": {
                  "enum": [
                    "low",
                    "medium",
                    "high",
                    "xhigh",
                    "max",
                    "ultra"
                  ]
                }
              },
              "additionalProperties": false,
              "allOf": [
                {
                  "if": {
                    "properties": {
                      "cli": {
                        "const": "agy"
                      },
                      "model": {}
                    },
                    "required": [
                      "cli",
                      "model"
                    ]
                  },
                  "then": {
                    "properties": {
                      "model": {
                        "type": "string",
                        "pattern": "-(low|medium|high)$"
                      }
                    }
                  }
                },
                {
                  "if": {
                    "properties": {
                      "cli": {
                        "const": "agy"
                      },
                      "model": {
                        "type": "string",
                        "pattern": "-low$"
                      }
                    },
                    "required": [
                      "cli",
                      "model"
                    ]
                  },
                  "then": {
                    "properties": {
                      "effort": {
                        "const": "low"
                      }
                    }
                  }
                },
                {
                  "if": {
                    "properties": {
                      "cli": {
                        "const": "agy"
                      },
                      "model": {
                        "type": "string",
                        "pattern": "-medium$"
                      }
                    },
                    "required": [
                      "cli",
                      "model"
                    ]
                  },
                  "then": {
                    "properties": {
                      "effort": {
                        "const": "medium"
                      }
                    }
                  }
                },
                {
                  "if": {
                    "properties": {
                      "cli": {
                        "const": "agy"
                      },
                      "model": {
                        "type": "string",
                        "pattern": "-high$"
                      }
                    },
                    "required": [
                      "cli",
                      "model"
                    ]
                  },
                  "then": {
                    "properties": {
                      "effort": {
                        "const": "high"
                      }
                    }
                  }
                }
              ]
            }
          }
        ]
      },
      "review_panel": {
        "anyOf": [
          {
            "type": "null"
          },
          {
            "type": "object",
            "propertyNames": {
              "enum": [
                "planning",
                "review"
              ]
            },
            "additionalProperties": {
              "type": "array",
              "minItems": 1,
              "items": {
                "type": "object",
                "required": [
                  "cli"
                ],
                "properties": {
                  "cli": {
                    "enum": [
                      "codex",
                      "agy"
                    ]
                  },
                  "model": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "^[A-Za-z0-9._-]+$"
                  }
                },
                "additionalProperties": false,
                "allOf": [
                  {
                    "if": {
                      "properties": {
                        "cli": {
                          "const": "agy"
                        },
                        "model": {}
                      },
                      "required": [
                        "cli",
                        "model"
                      ]
                    },
                    "then": {
                      "properties": {
                        "model": {
                          "type": "string",
                          "pattern": "-(low|medium|high)$"
                        }
                      }
                    }
                  }
                ]
              }
            }
          }
        ]
      },
      "codex_dispatch": {
        "anyOf": [
          {
            "type": "null"
          },
          {
            "type": "object",
            "properties": {
              "max_runtime_ms": {
                "type": "integer",
                "minimum": 1
              },
              "log_max_bytes": {
                "type": "integer",
                "minimum": 1
              }
            },
            "additionalProperties": false
          }
        ]
      },
      "mailbox": {
        "anyOf": [
          {
            "type": "null"
          },
          {
            "type": "object",
            "properties": {
              "max_bytes": {
                "type": "integer",
                "minimum": 1
              },
              "archive_policy": {
                "enum": [
                  "rotate",
                  "drop"
                ]
              },
              "archive_retention_days": {
                "type": "integer",
                "minimum": 0
              },
              "archive_retention_count": {
                "type": "integer",
                "minimum": 0
              }
            },
            "additionalProperties": false
          }
        ]
      },
      "worktree_bootstrap": {
        "anyOf": [
          {
            "type": "null"
          },
          {
            "type": "object",
            "properties": {
              "symlinks": {
                "type": "array",
                "items": {
                  "type": "string",
                  "minLength": 1,
                  "pattern": "^(?!/)(?!(?:[\\s\\S]*/)?\\.\\.(?:/|(?![\\s\\S])))[\\s\\S]+$"
                }
              }
            },
            "additionalProperties": true
          }
        ]
      }
    },
    "additionalProperties": true,
    "allOf": [
      {
        "if": {
          "properties": {
            "app": {
              "type": "object",
              "properties": {
                "type": {
                  "const": "library"
                }
              },
              "required": [
                "type"
              ]
            }
          },
          "required": [
            "app"
          ]
        },
        "then": {
          "properties": {
            "live_verification": {
              "type": "object",
              "properties": {
                "default": {
                  "const": "skip"
                },
                "skip_reason": {
                  "type": "string",
                  "pattern": ".*\\S.*"
                }
              },
              "required": [
                "default",
                "skip_reason"
              ]
            }
          }
        }
      }
    ],
    "$defs": {
      "window_time": {
        "description": "Loader coercion is String(value) tested against HH:MM; a singleton array (recursively) stringifies to its element.",
        "anyOf": [
          {
            "type": "string",
            "pattern": "^([01][0-9]|2[0-3]):[0-5][0-9]$"
          },
          {
            "type": "array",
            "minItems": 1,
            "maxItems": 1,
            "items": {
              "$ref": "#/$defs/window_time"
            }
          }
        ]
      }
    }
  },
  "runtime": [
    {
      "case": "minimal-defaults",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {}
      },
      "expect": {
        "ok": true,
        "config": {
          "version": 1,
          "app": {
            "type": "web"
          },
          "live_verification": {
            "takeover": {
              "mode": "confirm_each_phase_e",
              "scheduled_windows": []
            },
            "cleanup": {
              "on_success": "kill",
              "on_halt": "kill",
              "shutdown_command": null
            },
            "setup": {
              "reset_command": null,
              "seed_command": null,
              "login_profiles": {},
              "setup_timeout_ms": 60000
            },
            "logs": {
              "include_process_output": true,
              "max_bytes_per_source": 262144,
              "max_excerpt_bytes_per_scenario": 32768,
              "error_patterns": [
                "ERROR",
                "Unhandled",
                "TypeError",
                "500"
              ],
              "paths": []
            }
          },
          "worktree_bootstrap": {
            "symlinks": [
              {
                "path": "node_modules",
                "required": false
              },
              {
                "path": ".venv",
                "required": false
              },
              {
                "path": "venv",
                "required": false
              }
            ]
          }
        }
      }
    },
    {
      "case": "version-false-permissive",
      "input": {
        "version": false,
        "app": {
          "type": "web"
        },
        "live_verification": {}
      },
      "expect": {
        "ok": true,
        "config": {
          "version": false
        }
      }
    },
    {
      "case": "version-object-permissive",
      "input": {
        "version": {},
        "app": {
          "type": "web"
        },
        "live_verification": {}
      },
      "expect": {
        "ok": true,
        "config": {
          "version": {}
        }
      }
    },
    {
      "case": "web-default-number-permissive",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {
          "default": 0
        }
      },
      "expect": {
        "ok": true,
        "config": {
          "live_verification": {
            "default": 0
          }
        }
      }
    },
    {
      "case": "web-skip-reason-number-permissive",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {
          "skip_reason": 0
        }
      },
      "expect": {
        "ok": true,
        "config": {
          "live_verification": {
            "skip_reason": 0
          }
        }
      }
    },
    {
      "case": "valid-takeover-window",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {
          "takeover": {
            "mode": "scheduled_window",
            "scheduled_windows": [
              {
                "start": "09:00",
                "end": "17:30"
              }
            ]
          }
        }
      },
      "expect": {
        "ok": true,
        "config": {
          "live_verification": {
            "takeover": {
              "mode": "scheduled_window",
              "scheduled_windows": [
                {
                  "start": "09:00",
                  "end": "17:30"
                }
              ]
            }
          }
        }
      }
    },
    {
      "case": "set-login-password-env",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {
          "setup": {
            "login_profiles": {
              "primary": {
                "password_env": "CPS_CONTRACT_PASSWORD"
              }
            }
          }
        }
      },
      "env": {
        "CPS_CONTRACT_PASSWORD": "present"
      },
      "expect": {
        "ok": true,
        "config": {
          "live_verification": {
            "setup": {
              "login_profiles": {
                "primary": {
                  "password_env": "CPS_CONTRACT_PASSWORD"
                }
              }
            }
          }
        }
      }
    },
    {
      "case": "valid-worktree-opt-out",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {},
        "worktree_bootstrap": {
          "symlinks": []
        }
      },
      "expect": {
        "ok": true,
        "config": {
          "worktree_bootstrap": {
            "symlinks": []
          }
        }
      }
    },
    {
      "case": "valid-codex-dispatch",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {},
        "codex_dispatch": {
          "max_runtime_ms": 1,
          "log_max_bytes": 1
        }
      },
      "expect": {
        "ok": true,
        "config": {
          "codex_dispatch": {
            "max_runtime_ms": 1,
            "log_max_bytes": 1
          }
        }
      }
    },
    {
      "case": "valid-mailbox",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {},
        "mailbox": {
          "max_bytes": 1,
          "archive_policy": "drop",
          "archive_retention_days": 0,
          "archive_retention_count": 0
        }
      },
      "expect": {
        "ok": true,
        "config": {
          "mailbox": {
            "max_bytes": 1,
            "archive_policy": "drop",
            "archive_retention_days": 0,
            "archive_retention_count": 0
          }
        }
      }
    },
    {
      "case": "valid-codex-model",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {},
        "models": {
          "implement": {
            "cli": "codex",
            "model": "gpt-safe_1.0",
            "effort": "ultra"
          }
        }
      },
      "expect": {
        "ok": true,
        "config": {
          "models": {
            "implement": {
              "cli": "codex",
              "model": "gpt-safe_1.0",
              "effort": "ultra"
            }
          }
        }
      }
    },
    {
      "case": "valid-agy-model",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {},
        "models": {
          "review": {
            "cli": "agy",
            "model": "gemini-contract-high",
            "effort": "high"
          }
        }
      },
      "expect": {
        "ok": true,
        "config": {
          "models": {
            "review": {
              "cli": "agy",
              "model": "gemini-contract-high",
              "effort": "high"
            }
          }
        }
      }
    },
    {
      "case": "valid-review-panel",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {},
        "review_panel": {
          "planning": [
            {
              "cli": "codex"
            },
            {
              "cli": "agy",
              "model": "gemini-contract-high"
            }
          ],
          "review": [
            {
              "cli": "codex",
              "model": "gpt-6-astra"
            }
          ]
        }
      },
      "expect": {
        "ok": true,
        "config": {
          "review_panel": {
            "planning": [
              {
                "cli": "codex"
              },
              {
                "cli": "agy",
                "model": "gemini-contract-high"
              }
            ],
            "review": [
              {
                "cli": "codex",
                "model": "gpt-6-astra"
              }
            ]
          }
        }
      }
    },
    {
      "case": "live-verification-array-permissive",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": []
      },
      "expect": {
        "ok": true,
        "config": {
          "version": 1
        }
      }
    },
    {
      "case": "takeover-null-defaulted",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {
          "takeover": null
        }
      },
      "expect": {
        "ok": true,
        "config": {
          "live_verification": {
            "takeover": {
              "mode": "confirm_each_phase_e",
              "scheduled_windows": []
            }
          }
        }
      }
    },
    {
      "case": "takeover-array-permissive",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {
          "takeover": []
        }
      },
      "expect": {
        "ok": true,
        "config": {
          "version": 1
        }
      }
    },
    {
      "case": "scheduled-windows-non-array-defaulted",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {
          "takeover": {
            "scheduled_windows": "daily"
          }
        }
      },
      "expect": {
        "ok": true,
        "config": {
          "live_verification": {
            "takeover": {
              "scheduled_windows": []
            }
          }
        }
      }
    },
    {
      "case": "scheduled-window-primitive-permissive",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {
          "takeover": {
            "scheduled_windows": [
              42
            ]
          }
        }
      },
      "expect": {
        "ok": true,
        "config": {
          "live_verification": {
            "takeover": {
              "scheduled_windows": [
                42
              ]
            }
          }
        }
      }
    },
    {
      "case": "scheduled-window-array-coercion",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {
          "takeover": {
            "scheduled_windows": [
              {
                "start": [
                  "09:00"
                ],
                "end": [
                  "17:30"
                ]
              }
            ]
          }
        }
      },
      "expect": {
        "ok": true,
        "config": {
          "live_verification": {
            "takeover": {
              "scheduled_windows": [
                {
                  "start": [
                    "09:00"
                  ],
                  "end": [
                    "17:30"
                  ]
                }
              ]
            }
          }
        }
      }
    },
    {
      "case": "scheduled-window-array-invalid",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {
          "takeover": {
            "scheduled_windows": [
              {
                "start": [
                  "25:00"
                ]
              }
            ]
          }
        }
      },
      "expect": {
        "error": "invalid-time-format"
      }
    },
    {
      "case": "scheduled-window-nested-array-coercion",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {
          "takeover": {
            "scheduled_windows": [
              {
                "start": [
                  [
                    "09:00"
                  ]
                ],
                "end": [
                  [
                    [
                      "17:30"
                    ]
                  ]
                ]
              }
            ]
          }
        }
      },
      "expect": {
        "ok": true,
        "config": {
          "live_verification": {
            "takeover": {
              "scheduled_windows": [
                {
                  "start": [
                    [
                      "09:00"
                    ]
                  ],
                  "end": [
                    [
                      [
                        "17:30"
                      ]
                    ]
                  ]
                }
              ]
            }
          }
        }
      }
    },
    {
      "case": "scheduled-window-nested-array-invalid",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {
          "takeover": {
            "scheduled_windows": [
              {
                "start": [
                  [
                    "25:00"
                  ]
                ]
              }
            ]
          }
        }
      },
      "expect": {
        "error": "invalid-time-format"
      }
    },
    {
      "case": "scheduled-window-multi-element-array-invalid",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {
          "takeover": {
            "scheduled_windows": [
              {
                "start": [
                  "09:00",
                  "10:00"
                ]
              }
            ]
          }
        }
      },
      "expect": {
        "error": "invalid-time-format"
      }
    },
    {
      "case": "worktree-null-defaulted",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {},
        "worktree_bootstrap": null
      },
      "expect": {
        "ok": true,
        "config": {
          "worktree_bootstrap": {
            "symlinks": [
              {
                "path": "node_modules",
                "required": false
              },
              {
                "path": ".venv",
                "required": false
              },
              {
                "path": "venv",
                "required": false
              }
            ]
          }
        }
      }
    },
    {
      "case": "worktree-missing-symlinks-defaulted",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {},
        "worktree_bootstrap": {}
      },
      "expect": {
        "ok": true,
        "config": {
          "worktree_bootstrap": {
            "symlinks": [
              {
                "path": "node_modules",
                "required": false
              },
              {
                "path": ".venv",
                "required": false
              },
              {
                "path": "venv",
                "required": false
              }
            ]
          }
        }
      }
    },
    {
      "case": "worktree-newline-name-permissive",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {},
        "worktree_bootstrap": {
          "symlinks": [
            "a\nb"
          ]
        }
      },
      "expect": {
        "ok": true,
        "config": {
          "worktree_bootstrap": {
            "symlinks": [
              {
                "path": "a\nb",
                "required": true
              }
            ]
          }
        }
      }
    },
    {
      "case": "worktree-trailing-newline-parent-permissive",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {},
        "worktree_bootstrap": {
          "symlinks": [
            "..\n"
          ]
        }
      },
      "expect": {
        "ok": true,
        "config": {
          "worktree_bootstrap": {
            "symlinks": [
              {
                "path": "..\n",
                "required": true
              }
            ]
          }
        }
      }
    },
    {
      "case": "invalid-app-type",
      "input": {
        "version": 1,
        "app": {
          "type": "service"
        },
        "live_verification": {}
      },
      "expect": {
        "error": "invalid-app-type"
      }
    },
    {
      "case": "missing-live-verification",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        }
      },
      "expect": {
        "error": "missing-field:live_verification"
      }
    },
    {
      "case": "invalid-takeover-mode",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {
          "takeover": {
            "mode": "always"
          }
        }
      },
      "expect": {
        "error": "invalid-takeover-mode"
      }
    },
    {
      "case": "invalid-window-start",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {
          "takeover": {
            "scheduled_windows": [
              {
                "start": "25:00"
              }
            ]
          }
        }
      },
      "expect": {
        "error": "invalid-time-format"
      }
    },
    {
      "case": "invalid-window-end",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {
          "takeover": {
            "scheduled_windows": [
              {
                "end": "12:60"
              }
            ]
          }
        }
      },
      "expect": {
        "error": "invalid-time-format"
      }
    },
    {
      "case": "library-must-skip",
      "input": {
        "version": 1,
        "app": {
          "type": "library"
        },
        "live_verification": {
          "default": "run",
          "skip_reason": "none"
        }
      },
      "expect": {
        "error": "library-must-skip"
      }
    },
    {
      "case": "library-missing-skip-reason",
      "input": {
        "version": 1,
        "app": {
          "type": "library"
        },
        "live_verification": {
          "default": "skip",
          "skip_reason": " "
        }
      },
      "expect": {
        "error": "library-missing-skip-reason"
      }
    },
    {
      "case": "worktree-block-not-object",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {},
        "worktree_bootstrap": "bad"
      },
      "expect": {
        "error": "invalid-worktree-bootstrap"
      }
    },
    {
      "case": "worktree-symlinks-not-array",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {},
        "worktree_bootstrap": {
          "symlinks": "bad"
        }
      },
      "expect": {
        "error": "invalid-worktree-bootstrap"
      }
    },
    {
      "case": "worktree-symlink-not-string",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {},
        "worktree_bootstrap": {
          "symlinks": [
            42
          ]
        }
      },
      "expect": {
        "error": "invalid-worktree-bootstrap"
      }
    },
    {
      "case": "worktree-symlink-empty",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {},
        "worktree_bootstrap": {
          "symlinks": [
            ""
          ]
        }
      },
      "expect": {
        "error": "invalid-worktree-bootstrap"
      }
    },
    {
      "case": "worktree-symlink-absolute",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {},
        "worktree_bootstrap": {
          "symlinks": [
            "/tmp/cache"
          ]
        }
      },
      "expect": {
        "error": "invalid-worktree-bootstrap"
      }
    },
    {
      "case": "worktree-symlink-traversal",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {},
        "worktree_bootstrap": {
          "symlinks": [
            "packages/../cache"
          ]
        }
      },
      "expect": {
        "error": "invalid-worktree-bootstrap"
      }
    },
    {
      "case": "codex-dispatch-not-object",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {},
        "codex_dispatch": []
      },
      "expect": {
        "error": "live-verification-config-malformed"
      }
    },
    {
      "case": "codex-dispatch-runtime-invalid",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {},
        "codex_dispatch": {
          "max_runtime_ms": 0
        }
      },
      "expect": {
        "error": "live-verification-config-malformed"
      }
    },
    {
      "case": "codex-dispatch-log-invalid",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {},
        "codex_dispatch": {
          "log_max_bytes": 1.5
        }
      },
      "expect": {
        "error": "live-verification-config-malformed"
      }
    },
    {
      "case": "codex-dispatch-unknown-key",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {},
        "codex_dispatch": {
          "future": true
        }
      },
      "expect": {
        "error": "live-verification-config-malformed"
      }
    },
    {
      "case": "mailbox-not-object",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {},
        "mailbox": []
      },
      "expect": {
        "error": "live-verification-config-malformed"
      }
    },
    {
      "case": "mailbox-max-invalid",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {},
        "mailbox": {
          "max_bytes": 0
        }
      },
      "expect": {
        "error": "live-verification-config-malformed"
      }
    },
    {
      "case": "mailbox-policy-invalid",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {},
        "mailbox": {
          "archive_policy": "archive"
        }
      },
      "expect": {
        "error": "live-verification-config-malformed"
      }
    },
    {
      "case": "mailbox-retention-days-invalid",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {},
        "mailbox": {
          "archive_retention_days": -1
        }
      },
      "expect": {
        "error": "live-verification-config-malformed"
      }
    },
    {
      "case": "mailbox-retention-count-invalid",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {},
        "mailbox": {
          "archive_retention_count": 1.5
        }
      },
      "expect": {
        "error": "live-verification-config-malformed"
      }
    },
    {
      "case": "mailbox-unknown-key",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {},
        "mailbox": {
          "future": true
        }
      },
      "expect": {
        "error": "live-verification-config-malformed"
      }
    },
    {
      "case": "models-not-object",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {},
        "models": []
      },
      "expect": {
        "error": "models-config-malformed"
      }
    },
    {
      "case": "models-unknown-role",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {},
        "models": {
          "future": {}
        }
      },
      "expect": {
        "error": "models-config-malformed"
      }
    },
    {
      "case": "models-role-not-object",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {},
        "models": {
          "review": []
        }
      },
      "expect": {
        "error": "models-config-malformed"
      }
    },
    {
      "case": "models-unknown-key",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {},
        "models": {
          "review": {
            "future": true
          }
        }
      },
      "expect": {
        "error": "models-config-malformed"
      }
    },
    {
      "case": "models-cli-invalid",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {},
        "models": {
          "review": {
            "cli": "gemini"
          }
        }
      },
      "expect": {
        "error": "models-config-malformed"
      }
    },
    {
      "case": "models-model-empty",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {},
        "models": {
          "review": {
            "model": ""
          }
        }
      },
      "expect": {
        "error": "models-config-malformed"
      }
    },
    {
      "case": "models-model-unsafe-token",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {},
        "models": {
          "review": {
            "model": "model with spaces"
          }
        }
      },
      "expect": {
        "error": "models-config-malformed"
      }
    },
    {
      "case": "models-effort-invalid",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {},
        "models": {
          "review": {
            "effort": "extreme"
          }
        }
      },
      "expect": {
        "error": "models-config-malformed"
      }
    },
    {
      "case": "models-agy-suffix-invalid",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {},
        "models": {
          "review": {
            "cli": "agy",
            "model": "gemini-contract"
          }
        }
      },
      "expect": {
        "error": "models-config-malformed"
      }
    },
    {
      "case": "models-agy-effort-mismatch",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {},
        "models": {
          "review": {
            "cli": "agy",
            "model": "gemini-contract-high",
            "effort": "low"
          }
        }
      },
      "expect": {
        "error": "models-config-malformed"
      }
    },
    {
      "case": "review-panel-cli-invalid",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {},
        "review_panel": {
          "planning": [
            {
              "cli": "unknown"
            }
          ]
        }
      },
      "expect": {
        "error": "models-config-malformed"
      }
    },
    {
      "case": "version-2-permissive",
      "input": {
        "version": 2,
        "app": {
          "type": "web"
        },
        "live_verification": {}
      },
      "expect": {
        "ok": true,
        "config": {
          "version": 2
        }
      }
    },
    {
      "case": "unknown-top-level-permissive",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {},
        "future_key": {
          "ignoredByValidation": true
        }
      },
      "expect": {
        "ok": true,
        "config": {
          "future_key": {
            "ignoredByValidation": true
          }
        }
      }
    },
    {
      "case": "null-optional-blocks",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {},
        "models": null,
        "codex_dispatch": null,
        "mailbox": null
      },
      "expect": {
        "ok": true,
        "config": {
          "models": null,
          "codex_dispatch": null,
          "mailbox": null
        }
      }
    },
    {
      "case": "unset-login-password-env",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {
          "setup": {
            "login_profiles": {
              "primary": {
                "password_env": "CPS_CONTRACT_MISSING_PASSWORD"
              }
            }
          }
        }
      },
      "env": {
        "CPS_CONTRACT_MISSING_PASSWORD": null
      },
      "schema_runtime_exception": "password_env presence depends on process.env",
      "expect": {
        "error": "live-verification-config-malformed"
      }
    },
    {
      "case": "error-precedence-version-before-app",
      "input": {
        "live_verification": {}
      },
      "expect": {
        "error": "missing-field:version"
      }
    },
    {
      "case": "missing-app",
      "input": {
        "version": 1,
        "live_verification": {}
      },
      "expect": {
        "error": "missing-field:app"
      }
    },
    {
      "case": "malformed-models",
      "input": {
        "version": 1,
        "app": {
          "type": "web"
        },
        "live_verification": {},
        "models": {
          "implement": {
            "model": 42
          }
        }
      },
      "expect": {
        "error": "models-config-malformed"
      }
    }
  ]
}
```

```json public-api:sidecar
{
  "stability": "stable",
  "since": "0.18.0",
  "version": 1,
  "top_level_keys": [
    "codex_session",
    "created_at",
    "feature",
    "model",
    "open_contentions",
    "panel_roster",
    "reasoning_effort",
    "rounds",
    "slice_reviews",
    "thread_config",
    "version"
  ]
}
```

```json public-api:semver
{
  "stability": "stable",
  "since": "0.18.0",
  "policy": {
    "breaking_stable_change": "major",
    "stable_addition": "minor",
    "internal_change": "patch"
  },
  "wrapper_requirement": "role-aware invocations use --model-role",
  "public": [
    "commands/*.md",
    "skills named by commands",
    "lib/codex-bridge/cli.js",
    "scripts/codex-exec-with-status.sh",
    "bin/codex-paired-doctor",
    ".codex-paired/project.json",
    "sidecar version"
  ],
  "internal": [
    "lib/** except lib/codex-bridge/cli.js"
  ]
}
```
