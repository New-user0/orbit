#!/usr/bin/env bash
# Runs inside the container: clones the bundle at the given commit, installs, and runs each package's own test script.
# Usage: run.sh <commit> <package>...
set -u
commit="$1"; shift
git config --global core.autocrlf false
git config --global user.email tester@example.invalid
git config --global user.name tester
git clone -q -b "$(cat /in/ref)" /in/orbit.bundle orbit && cd orbit && git checkout -q "$commit" || exit 2
echo "HEAD $(git log --oneline -1)"
bun install --frozen-lockfile > /tmp/install.log 2>&1 || { tail -n 30 /tmp/install.log; exit 3; }
for package in "$@"; do
  log="/out/$package.log"
  ( cd "packages/$package" && ORBIT_EGRESS_IDLE_MS=120000 timeout 3600 bun run test ${TEST_FILES:-} ) > "$log" 2>&1
  code=$?
  summary=$(grep -E '^ *[0-9]+ (pass|fail|skip)$' "$log" | tr -s ' ' | tr '\n' ' ')
  echo "PACKAGE $package exit=$code $summary"
  grep -E '^\(fail\)' "$log" | sed 's/ \[[0-9.]*m\?s\]$//' | sed "s/^/  FAIL $package: /"
done
