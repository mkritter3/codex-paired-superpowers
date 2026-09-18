#!/usr/bin/env bash
set -u

echo "term-resistant pid: $$" >&2
trap ':' TERM

if [ -n "${CPS_TEST_PID_FILE:-}" ]; then
  node -e '
    const { spawn } = require("node:child_process");
    const { writeFileSync } = require("node:fs");
    const ignored = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    const inherited = spawn("sleep", ["30"], { detached: true, stdio: "inherit" });
    writeFileSync(process.argv[1], `${JSON.stringify([ignored.pid, inherited.pid])}\n`);
    ignored.unref();
    inherited.unref();
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 30_000);
  ' "$CPS_TEST_PID_FILE"
fi

while :; do
  sleep 60
done
