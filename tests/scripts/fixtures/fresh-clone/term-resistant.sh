#!/usr/bin/env bash
set -u

echo "term-resistant pid: $$" >&2
trap ':' TERM

while :; do
  sleep 60
done
