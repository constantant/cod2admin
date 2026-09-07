#!/usr/bin/env bash
# Orchestrates a full release. `nx release` alone only bumps apps/*/packages/* package.json
# versions and writes CHANGELOG.md - it never touches the root package.json (root isn't an Nx
# project, see `nx show projects`) and knows nothing about the installer archive that
# scripts/build-installer-bundle.sh produces. This script chains the pieces nx release can't:
#   1. bump versions                         (nx release version)
#   2. sync root package.json to that version (build-installer-bundle.sh reads it for the
#      archive's filename, so it must match the just-bumped release version)
#   3. write the changelog                   (nx release changelog)
#   4. rebuild installer/cod2admin-gateway-<version>.tar.gz from the newly bumped/built sources,
#      then wrap it with install.sh + README.md into one install-ready release archive
#   5. commit + tag everything as one release
#   6. push the release commit/tag and publish a GitHub Release with that one archive attached
#
# Split into `nx release version` + `nx release changelog` (each with --no-git-commit
# --no-git-tag) instead of the single `nx release` command, specifically so steps 2 and 4 can run
# in between with the new version already on disk but before anything is committed/tagged.
#
# Step 6 pushes straight to main and publishes publicly - no further confirmation prompt once
# this script is running for real. main is PR-protected for everyone else, but pushes from an
# admin account (enforce_admins: false) still go through directly, which is what this relies on.
set -euo pipefail

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

if command -v pnpm >/dev/null 2>&1; then
  PNPM=pnpm
else
  PNPM="corepack pnpm"
fi

DRY_RUN=false
SPECIFIER=""
EXTRA_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --dry-run|-d) DRY_RUN=true ;;
    -*) EXTRA_ARGS+=("$arg") ;;
    # A bare positional (e.g. "patch", "minor", "1.2.3") is a version specifier - valid for
    # `nx release version` but not for `nx release changelog`, which only takes a version string
    # (already supplied explicitly below) plus flags. Keep it out of EXTRA_ARGS so it doesn't
    # get forwarded to changelog as a stray, unexpected positional.
    *) SPECIFIER="$arg" ;;
  esac
done

if $DRY_RUN; then
  # A real dry-run of steps 2/4/5 would mean writing a real archive and diffing git state without
  # committing it - more machinery than a preview needs. `nx release --dry-run` already previews
  # the part that actually varies release to release (which bump, what the changelog will say).
  echo "==> Dry run: previewing version bump + changelog only"
  echo "    (root version sync, archive build, commit, and tag only happen on a real release)"
  DRY_SPECIFIER_ARGS=()
  [ -n "$SPECIFIER" ] && DRY_SPECIFIER_ARGS+=("$SPECIFIER")
  $PNPM exec nx release --dry-run "${DRY_SPECIFIER_ARGS[@]}" "${EXTRA_ARGS[@]}"
  exit 0
fi

echo "==> Bumping versions"
# nx.json sets versionActionsOptions.skipLockFileUpdate: true - nx's own lockfile step shells out
# to a bare `pnpm` binary, which isn't on PATH in this workspace (see CLAUDE.md: only
# `corepack pnpm` is guaranteed to resolve). We update the lockfile ourselves below instead.
SPECIFIER_ARGS=()
[ -n "$SPECIFIER" ] && SPECIFIER_ARGS+=("$SPECIFIER")
$PNPM exec nx release version --no-git-commit --no-git-tag "${SPECIFIER_ARGS[@]}" "${EXTRA_ARGS[@]}"

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

echo "==> Linking the changelog heading to its GitHub release"
# nx's changelog renderer doesn't have a repo configured to link against, so the heading it
# writes is plain text - point it at the release this script publishes below.
node -e '
const fs = require("fs");
const version = process.argv[1];
const text = fs.readFileSync("CHANGELOG.md", "utf8");
const heading = new RegExp("^## " + version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " \\(", "m");
const url = "https://github.com/constantant/cod2admin/releases/tag/v" + version;
const linked = text.replace(heading, "## [" + version + "](" + url + ") (");
fs.writeFileSync("CHANGELOG.md", linked);
' "$VERSION"

echo "==> Building installer archive for $VERSION"
"$ROOT_DIR/scripts/build-installer-bundle.sh"

echo "==> Packaging single install-ready release archive for $VERSION"
# installer/install.sh expects install.sh, README.md, cod2admin-gateway-*.tar.gz (+ its .sha256),
# apply-update.sh, and lib/ to sit together in one directory (see installer/README.md's install
# steps and docs/PLAN.md §13.5) - wrap all of it into one archive so a human installing by hand
# has exactly one thing to download (installer/README.md's curl one-liner).
RELEASE_STAGE="$ROOT_DIR/out/cod2admin-${VERSION}"
RELEASE_ARCHIVE="$ROOT_DIR/out/cod2admin-${VERSION}.tar.gz"
rm -rf "$RELEASE_STAGE" "$RELEASE_ARCHIVE"
mkdir -p "$RELEASE_STAGE"
cp "installer/install.sh" "installer/apply-update.sh" "installer/README.md" \
  "installer/cod2admin-gateway-${VERSION}.tar.gz" "installer/cod2admin-gateway-${VERSION}.tar.gz.sha256" \
  "$RELEASE_STAGE/"
cp -r "installer/lib" "$RELEASE_STAGE/lib"
tar -czf "$RELEASE_ARCHIVE" -C "$ROOT_DIR/out" "cod2admin-${VERSION}"
rm -rf "$RELEASE_STAGE"

echo "==> Committing and tagging release"
git add package.json apps/*/package.json packages/*/package.json CHANGELOG.md pnpm-lock.yaml
git commit -m "chore(release): publish v${VERSION}"
git tag "v${VERSION}"

echo "==> Pushing release commit and tag"
git push origin HEAD
git push origin "v${VERSION}"

echo "==> Publishing GitHub release v${VERSION}"
# Two extra assets alongside the human-facing $RELEASE_ARCHIVE: the gateway tarball and its
# checksum, published directly (not just nested inside $RELEASE_ARCHIVE) so the gateway's
# `/update` command (docs/PLAN.md §13.2/§13.3) can fetch exactly what it needs without unwrapping
# a tarball-inside-a-tarball. installer/README.md's/docs/PLAN.md §12's/docs/PLAN-ru.md's curl
# one-liner filters these two out (`grep -v gateway`) so it still only ever grabs $RELEASE_ARCHIVE.
GATEWAY_TARBALL="installer/cod2admin-gateway-${VERSION}.tar.gz"
GATEWAY_CHECKSUM="installer/cod2admin-gateway-${VERSION}.tar.gz.sha256"
if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI not found - skipping GitHub release. Run manually:"
  echo "  gh release create v${VERSION} $RELEASE_ARCHIVE $GATEWAY_TARBALL $GATEWAY_CHECKSUM --title v${VERSION} --notes-file <(sed -n '/^## \[${VERSION}\]/,/^## /p' CHANGELOG.md)"
else
  # CHANGELOG.md accumulates every past release - pull out just this version's section so old
  # entries aren't repeated as this release's notes.
  NOTES_FILE=$(mktemp)
  node -e '
  const fs = require("fs");
  const version = process.argv[1];
  const text = fs.readFileSync("CHANGELOG.md", "utf8");
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp("^## \\[" + escaped + "\\]", "m");
  const start = text.search(heading);
  if (start === -1) throw new Error("No CHANGELOG.md section found for " + version);
  const rest = text.slice(start);
  const nextHeadingOffset = rest.slice(1).search(/^## /m);
  const section = nextHeadingOffset === -1 ? rest : rest.slice(0, nextHeadingOffset + 1);
  fs.writeFileSync(process.argv[2], section.trim() + "\n");
  ' "$VERSION" "$NOTES_FILE"

  gh release create "v${VERSION}" "$RELEASE_ARCHIVE" "$GATEWAY_TARBALL" "$GATEWAY_CHECKSUM" \
    --title "v${VERSION}" \
    --notes-file "$NOTES_FILE"
  rm -f "$NOTES_FILE"
fi

echo
echo "Done: v${VERSION} released - committed, tagged, pushed, and published on GitHub."
echo "Release archive: $RELEASE_ARCHIVE"
