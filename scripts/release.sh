#!/usr/bin/env bash
# Orchestrates a full release. `nx release` alone only bumps apps/*/packages/* package.json
# versions and writes CHANGELOG.md - it never touches the root package.json (root isn't an Nx
# project, see `nx show projects`) and knows nothing about the installer archive that
# scripts/build-installer-bundle.sh produces. This script chains the pieces nx release can't:
#   1. bump versions                         (nx release version)
#   2. sync root package.json to that version (build-installer-bundle.sh reads it for the
#      archive's filename, so it must match the just-bumped release version)
#   3. write the changelog                   (nx release changelog)
#   4. rebuild installer/cod2admin-gateway-<version>.tar.gz from the newly bumped/built sources
#   5. commit + tag everything as one release
#
# Split into `nx release version` + `nx release changelog` (each with --no-git-commit
# --no-git-tag) instead of the single `nx release` command, specifically so steps 2 and 4 can run
# in between with the new version already on disk but before anything is committed/tagged.
set -euo pipefail

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

if command -v pnpm >/dev/null 2>&1; then
  PNPM=pnpm
else
  PNPM="corepack pnpm"
fi

DRY_RUN=false
EXTRA_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --dry-run|-d) DRY_RUN=true ;;
    *) EXTRA_ARGS+=("$arg") ;;
  esac
done

if $DRY_RUN; then
  # A real dry-run of steps 2/4/5 would mean writing a real archive and diffing git state without
  # committing it - more machinery than a preview needs. `nx release --dry-run` already previews
  # the part that actually varies release to release (which bump, what the changelog will say).
  echo "==> Dry run: previewing version bump + changelog only"
  echo "    (root version sync, archive build, commit, and tag only happen on a real release)"
  $PNPM exec nx release --dry-run "${EXTRA_ARGS[@]}"
  exit 0
fi

echo "==> Bumping versions"
# nx.json sets versionActionsOptions.skipLockFileUpdate: true - nx's own lockfile step shells out
# to a bare `pnpm` binary, which isn't on PATH in this workspace (see CLAUDE.md: only
# `corepack pnpm` is guaranteed to resolve). We update the lockfile ourselves below instead.
$PNPM exec nx release version --no-git-commit --no-git-tag "${EXTRA_ARGS[@]}"

VERSION=$(node -p "require('./apps/gateway/package.json').version")
echo "==> Resolved release version: $VERSION"

echo "==> Updating pnpm lock file"
$PNPM install --lockfile-only

echo "==> Syncing root package.json to $VERSION (nx release never touches it - not an Nx project)"
node -e '
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.version = process.argv[1];
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
' "$VERSION"

echo "==> Generating changelog for $VERSION"
$PNPM exec nx release changelog "$VERSION" --no-git-commit --no-git-tag "${EXTRA_ARGS[@]}"

echo "==> Building installer archive for $VERSION"
"$ROOT_DIR/scripts/build-installer-bundle.sh"

echo "==> Committing and tagging release"
git add package.json apps/*/package.json packages/*/package.json CHANGELOG.md pnpm-lock.yaml
git commit -m "chore(release): publish v${VERSION}"
git tag "v${VERSION}"

echo
echo "Done: release v${VERSION} committed and tagged locally."
echo "Archive ready at installer/cod2admin-gateway-${VERSION}.tar.gz"
echo "Nothing was pushed - push when ready: git push --follow-tags"
