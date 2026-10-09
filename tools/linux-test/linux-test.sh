#!/usr/bin/env bash
# Runs package test suites on Linux in Docker, the way CI's ubuntu test job runs them: each package's own
# `bun run test`, as a user who is not root, with ORBIT_EGRESS_IDLE_MS=120000.
# Usage: tools/linux-test/linux-test.sh <git ref> [package...]   (packages default to CI's matrix)
#        TEST_FILES="test/a.test.ts test/b.test.ts" tools/linux-test/linux-test.sh <git ref> <package>
# The commit is bundled and cloned inside the container, so Linux file, link and permission rules apply.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(git -C "$here" rev-parse --show-toplevel)"
ref="${1:?usage: linux-test.sh <git ref> [package...]}"
shift
packages=("$@")
[ ${#packages[@]} -gt 0 ] || packages=(ai cli client codemode compat core flow plugin protocol schema sdk server theme tui util vscode)

docker info > /dev/null 2>&1 || {
  desktop="/c/Program Files/Docker/Docker/Docker Desktop.exe"
  [ -x "$desktop" ] || { echo "Docker is not running"; exit 1; }
  echo "starting Docker Desktop"
  "$desktop" > /dev/null 2>&1 &
  for _ in $(seq 1 90); do docker info > /dev/null 2>&1 && break; sleep 2; done
  docker info > /dev/null 2>&1 || { echo "Docker did not start"; exit 1; }
}
# The tag follows the Dockerfile, so a changed Dockerfile builds a new image.
image="orbit-linux-test:$(git -C "$here" hash-object Dockerfile | cut -c 1-12)"
docker image inspect "$image" > /dev/null 2>&1 || docker build -q -t "$image" "$here" > /dev/null || exit 1

commit=$(git -C "$repo" rev-parse --verify "$ref^{commit}") || exit 1
work=$(mktemp -d)
tmpref="linux-test-$(basename "$work")"
git -C "$repo" branch -f "$tmpref" "$commit" > /dev/null && git -C "$repo" bundle create "$work/orbit.bundle" "$tmpref" > /dev/null 2>&1 || exit 1
git -C "$repo" branch -D "$tmpref" > /dev/null 2>&1
echo "$tmpref" > "$work/ref"
cp "$here/run.sh" "$work/run.sh"
mkdir -p "$work/out" && chmod 777 "$work/out"
mount=$(command -v cygpath > /dev/null && cygpath -m "$work" || echo "$work")
echo "commit $commit, logs in $mount/out"
# The bubblewrap test needs user namespaces, which Docker's default seccomp and AppArmor profiles block.
MSYS_NO_PATHCONV=1 docker run --rm --security-opt seccomp=unconfined --security-opt apparmor=unconfined -e TEST_FILES \
  -v "$mount:/in:ro" -v "$mount/out:/out" "$image" bash /in/run.sh "$commit" "${packages[@]}"
