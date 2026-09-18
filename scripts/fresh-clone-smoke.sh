#!/usr/bin/env bash
# Exercise doctor, implementer, and reviewer flows from a repository clone.
set -uo pipefail

TMP_ROOT=""
REPO_ROOT=""
REVIEW_SHA=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --tmp-root) TMP_ROOT="${2:-}"; shift 2 ;;
    --repo-root) REPO_ROOT="${2:-}"; shift 2 ;;
    --sha) REVIEW_SHA="${2:-}"; shift 2 ;;
    *) echo "FAIL step 0 isolation: unknown argument $1" >&2; exit 1 ;;
  esac
done

fail() {
  echo "FAIL step $1: $2" >&2
  exit 1
}

[ -n "$TMP_ROOT" ] || fail "0 isolation" "--tmp-root is required"
[ -n "$REPO_ROOT" ] || fail "0 isolation" "--repo-root is required"

# Step 0: capture the matrix tools, then isolate configuration and PATH.
NODE_BIN=$(command -v node) || fail "0 isolation" "node is not available"
GIT_BIN=$(command -v git) || fail "0 isolation" "git is not available"
OUTER_NODE_VERSION=$("$NODE_BIN" --version) || fail "0 isolation" "cannot read outer node version"
mkdir -p "$TMP_ROOT/bin" "$TMP_ROOT/home" || fail "0 isolation" "cannot create isolated directories"
ln -s "$NODE_BIN" "$TMP_ROOT/bin/node" || fail "0 isolation" "cannot link node"
ln -s "$GIT_BIN" "$TMP_ROOT/bin/git" || fail "0 isolation" "cannot link git"

for inherited_name in $(env | sed -n \
  -e 's/^\(CODEX_PAIRED_[A-Za-z0-9_]*\)=.*/\1/p' \
  -e 's/^\(FAKE_[A-Za-z0-9_]*\)=.*/\1/p'); do
  unset "$inherited_name"
done

export HOME="$TMP_ROOT/home"
export PATH="$TMP_ROOT/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cat > "$HOME/.gitconfig" <<'EOF'
[user]
  name = Fresh Clone Smoke
  email = fresh-clone@example.test
[commit]
  gpgsign = false
EOF

INNER_NODE_VERSION=$(node --version) || fail "0 isolation" "isolated node is unavailable"
[ "$INNER_NODE_VERSION" = "$OUTER_NODE_VERSION" ] || \
  fail "0 isolation" "inner node $INNER_NODE_VERSION differs from outer $OUTER_NODE_VERSION"

# Step 1: clone only tracked repository contents; do not install dependencies.
CLONE="$TMP_ROOT/clone"
git clone --depth 1 "file://$REPO_ROOT" "$CLONE" >/dev/null 2>&1 || \
  fail "1 clone" "git clone failed"
export CLAUDE_PLUGIN_ROOT="$CLONE"

# Step 2: expose the fake CLIs under the names used by production code.
cp "$CLONE/tests/fixtures/fake-cli/codex.sh" "$TMP_ROOT/bin/codex" || \
  fail "2 fake CLIs" "cannot install fake codex"
cp "$CLONE/tests/fixtures/fake-cli/agy.sh" "$TMP_ROOT/bin/agy" || \
  fail "2 fake CLIs" "cannot install fake agy"
chmod +x "$TMP_ROOT/bin/codex" "$TMP_ROOT/bin/agy" || \
  fail "2 fake CLIs" "cannot make fake CLIs executable"

# Step 3: a clone must pass doctor without any FAIL checks.
DOCTOR_JSON="$TMP_ROOT/doctor.json"
if ! (cd "$CLONE" && "$CLONE/bin/codex-paired-doctor" --json > "$DOCTOR_JSON"); then
  fail "3 doctor" "doctor returned non-zero"
fi
node -e '
  const report = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (report.checks.some((check) => check.status === "fail")) process.exit(1);
' "$DOCTOR_JSON" || fail "3 doctor" "doctor report contains a FAIL check"

# Step 4: create a clean project with explicit implement and review transports.
PROJECT="$TMP_ROOT/proj"
mkdir -p "$PROJECT/.codex-paired" "$PROJECT/docs" || fail "4 project" "cannot create project"
git -C "$PROJECT" init -q -b main || fail "4 project" "git init failed"
cat > "$PROJECT/.codex-paired/project.json" <<'EOF'
{
  "version": 1,
  "app": { "type": "library" },
  "live_verification": { "default": "skip", "skip_reason": "fresh-clone smoke" },
  "models": {
    "implement": { "cli": "codex", "model": "gpt-6-astra", "effort": "high" },
    "review": { "cli": "agy", "model": "gemini-3.8-flash-high", "effort": "high" }
  }
}
EOF
printf '%s\n' '.superpowers-codex-paired/' > "$PROJECT/.gitignore"
printf '%s\n' '# Fresh-clone smoke spec' > "$PROJECT/docs/spec.md"
git -C "$PROJECT" add . || fail "4 project" "git add failed"
git -C "$PROJECT" commit -qm initial || fail "4 project" "initial commit failed"
INITIAL_SHA=$(git -C "$PROJECT" rev-parse HEAD) || fail "4 project" "cannot read initial SHA"

# Step 5: run the implementer through the durable status wrapper.
STATUS_FILE="$TMP_ROOT/implement.status.json"
if ! FAKE_CODEX_COMMIT=1 "$CLONE/scripts/codex-exec-with-status.sh" \
  "$STATUS_FILE" --model-role implement --repo-root "$PROJECT" --cwd "$PROJECT" -- \
  codex exec 'Implement the smoke fixture.' </dev/null; then
  fail "5 implementer" "wrapper returned non-zero"
fi
node -e '
  const status = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (status.state !== "exited" || status.exit_code !== 0 || status.cli !== "codex") process.exit(1);
' "$STATUS_FILE" || fail "5 implementer" "terminal status is incorrect"
[ "$(git -C "$PROJECT" log -1 --format=%s)" = "fake: implement" ] || \
  fail "5 implementer" "fake implementation commit is missing"
IMPL_SHA=$(git -C "$PROJECT" rev-parse HEAD) || fail "5 implementer" "cannot read implementation SHA"

# Step 6: review exactly the implementation SHA in a throwaway checkout.
SPEC="$PROJECT/docs/spec.md"
node "$CLONE/lib/codex-bridge/cli.js" sidecar-init \
  --specPath "$SPEC" --feature fresh-clone --threadId seed \
  --model gpt-6-astra --reasoning high >/dev/null || fail "6 reviewer" "sidecar-init failed"

case "$REVIEW_SHA" in
  "") EFFECTIVE_REVIEW_SHA="$IMPL_SHA" ;;
  stale) EFFECTIVE_REVIEW_SHA="$INITIAL_SHA" ;;
  *) EFFECTIVE_REVIEW_SHA="$REVIEW_SHA" ;;
esac

AGY_RECORD="$TMP_ROOT/agy-record.json"
REVIEW_JSON="$TMP_ROOT/reviewer.json"
if ! printf '%s' 'Review the implementation.' | FAKE_AGY_RECORD="$AGY_RECORD" \
  node "$CLONE/lib/codex-bridge/cli.js" reviewer-thread-open \
    --role review --sha "$EFFECTIVE_REVIEW_SHA" --specPath "$SPEC" \
    --repoRoot "$PROJECT" --prompt-stdin > "$REVIEW_JSON"; then
  fail "6 reviewer" "reviewer-thread-open returned non-zero"
fi

if [ "${CPS_FRESH_CLONE_FAKE_RECORD_CWD:-}" = project ]; then
  node -e '
    const fs = require("node:fs");
    const recordPath = process.argv[1];
    const project = process.argv[2];
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    const alias = project.startsWith("/private/") ? project.slice(8) : `/private${project}`;
    try {
      record.cwd = fs.realpathSync(alias) === fs.realpathSync(project) ? alias : project;
    } catch {
      record.cwd = project;
    }
    fs.writeFileSync(recordPath, `${JSON.stringify(record)}\n`);
  ' "$AGY_RECORD" "$PROJECT" || fail "6 reviewer" "could not create cwd negative control"
fi

node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (value.ok !== true || typeof value.threadId !== "string" || value.threadId.length === 0) process.exit(1);
' "$REVIEW_JSON" || fail "6 reviewer" "review result is not successful"

SIDECAR="$PROJECT/.superpowers-codex-paired/docs/spec.md.json"
node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (value.role_sessions?.["execution-reviewer"] !== process.argv[2]) process.exit(1);
' "$SIDECAR" "$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).threadId' "$REVIEW_JSON")" || \
  fail "6 reviewer" "sidecar did not record the execution reviewer thread"

node -e '
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const canonicalize = (input) => {
    let existing = path.resolve(input);
    const missing = [];
    while (!fs.existsSync(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) throw new Error(`cannot canonicalize ${input}`);
      missing.unshift(path.basename(existing));
      existing = parent;
    }
    return path.join(fs.realpathSync(existing), ...missing);
  };
  const record = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (record.head !== process.argv[2]) process.exit(1);
  if (record.impl_txt_present !== true) process.exit(1);
  const reviewCwd = canonicalize(record.cwd);
  const project = canonicalize(process.argv[3]);
  if (reviewCwd === project) process.exit(1);
  const relative = path.relative(fs.realpathSync(os.tmpdir()), reviewCwd);
  const checkoutDir = relative.split(path.sep)[0];
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`)) process.exit(1);
  if (!/^cps-review-[^/\\]+$/.test(checkoutDir)) process.exit(1);
' "$AGY_RECORD" "$IMPL_SHA" "$PROJECT" || \
  fail "6 reviewer" "review did not observe the implementation in a throwaway checkout"

[ -z "$(git -C "$PROJECT" status --porcelain)" ] || \
  fail "6 reviewer" "review changed the project working tree"

# Step 7: one stable summary line for people and CI logs.
echo "PASS fresh-clone smoke (node $INNER_NODE_VERSION)"
