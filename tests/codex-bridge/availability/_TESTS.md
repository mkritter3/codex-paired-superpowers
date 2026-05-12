# Slice 4 — availability detection test inventory

CRITICAL tier (per plan § Slice 4): stale or wrong availability data
changes dispatch behavior, so every transition is exercised.

## prober.test.js (~5 tests)

- happy path: a known-available binary (`node` itself) probes as
  `status: 'available'` with non-null `resolved_path` + `version`
- missing binary: `command: '/nonexistent/binary'` → `status: 'missing'`,
  `error` mentions the missing command
- broken binary: a temp shell script that exits 1 on `--version` →
  `status: 'broken'`, `resolved_path` populated, `error` includes the
  exit code
- timeout: a temp script that sleeps 5s → `status: 'broken'`, `error`
  contains "timed out"
- claude-task with CLAUDECODE env set: `status: 'available'` even when the
  `claude` binary is missing (session detection)
- plugin_version: the field reflects `package.json` `version` at probe
  time

## cache.test.js (~6 tests)

- `readCache` returns null when file missing
- write + read round trip preserves entries + plugin_version + cached_at
- `isCacheFresh`: cached_at within TTL → true
- `isCacheFresh`: cached_at older than TTL → false
- `isCacheFresh`: plugin_version mismatch → false
- `isCacheFresh`: resolved_path missing from disk (existsSync stub) → false
- `clearCache`: removes file; second call no-ops cleanly

## detector.test.js (~5 tests)

- `detectAvailableCLIs` with no existing cache invokes proberFn for every
  cli-client and writes the cache
- `detectAvailableCLIs` with a fresh cache returns the cached Map without
  invoking proberFn
- `detectAvailableCLIs` with `force: true` re-probes regardless of cache
  freshness AND clears the on-disk cache first
- `availableCLISet` filters a Map<name, payload> to only names where
  status === 'available'
- `firstAvailableInLadder` walks a slice-3 recommendation preference array
  and returns the first ladder entry whose `cli` is in availableSet
