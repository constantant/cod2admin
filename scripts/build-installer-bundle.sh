#!/usr/bin/env bash
# Builds the self-contained gateway artifact that installer/install.sh extracts on a target
# host. Runs on a dev/CI machine with the full pnpm workspace — never on the admin's box.
#
# Manually vendors the built workspace packages plus a fresh, isolated install of their real
# (non-workspace) npm dependencies, rather than relying on `pnpm deploy`'s default packing rules
# — this repo's dist/ output is gitignored, and pnpm's packing (like `npm pack`) excludes
# gitignored files by default, which would silently ship an empty dist/. Building the bundle by
# hand sidesteps that entirely.
set -euo pipefail

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT_DIR"

if command -v pnpm >/dev/null 2>&1; then
  PNPM=pnpm
else
  PNPM="corepack pnpm"
fi

PROJECTS=(gateway admin-store ban-store log-tailer rcon-client report-pipeline)
VERSION=$(node -p "require('./package.json').version")
OUT_DIR="$ROOT_DIR/out"
BUNDLE_DIR="$OUT_DIR/gateway-bundle"
TARBALL="$ROOT_DIR/installer/cod2admin-gateway-${VERSION}.tar.gz"

echo "==> Building: ${PROJECTS[*]}"
$PNPM exec nx run-many -t build -p "$(IFS=,; echo "${PROJECTS[*]}")"

echo "==> Assembling bundle at $BUNDLE_DIR"
rm -rf "$BUNDLE_DIR"
mkdir -p "$BUNDLE_DIR/node_modules/@cod2admin"

cp -r "apps/gateway/dist" "$BUNDLE_DIR/dist"

for name in admin-store ban-store log-tailer rcon-client report-pipeline; do
  dest="$BUNDLE_DIR/node_modules/@cod2admin/$name"
  mkdir -p "$dest"
  cp -r "packages/$name/dist" "$dest/dist"
  cp "packages/$name/package.json" "$dest/package.json"
  # admin-store/ban-store resolve their drizzle-kit migrations relative to the package root at
  # runtime (fileURLToPath(new URL('../../drizzle', import.meta.url)) in migrate.ts) — must ship
  # alongside dist, or `migrate()` fails at startup with "Can't find meta/_journal.json file".
  if [ -d "packages/$name/drizzle" ]; then
    cp -r "packages/$name/drizzle" "$dest/drizzle"
  fi
done

echo "==> Resolving real (non-workspace) dependencies"
DEPS_MANIFEST="$BUNDLE_DIR/package.json"
node -e '
const fs = require("fs");
const pkgs = ["apps/gateway", "packages/admin-store", "packages/ban-store", "packages/log-tailer", "packages/rcon-client", "packages/report-pipeline"];
const deps = {};
for (const p of pkgs) {
  const pkg = JSON.parse(fs.readFileSync(p + "/package.json", "utf8"));
  for (const [name, range] of Object.entries(pkg.dependencies || {})) {
    if (range.startsWith("workspace:")) continue;
    deps[name] = range;
  }
}
fs.writeFileSync(process.argv[1], JSON.stringify({ name: "cod2admin-gateway-bundle", private: true, dependencies: deps }, null, 2));
' "$DEPS_MANIFEST"

echo "==> Installing real dependencies in isolation"
# node-linker=hoisted: pnpm's default layout symlinks into its content-addressable .pnpm store
# using absolute paths baked in at install time (e.g. /d/Work/.../out/gateway-bundle/node_modules
# /.pnpm/...) — those can never resolve once this bundle is copied anywhere else, on any OS.
# Hoisted gives a flat, real-file node_modules that survives being moved/tarred/extracted.
echo "node-linker=hoisted" > "$BUNDLE_DIR/.npmrc"
( cd "$BUNDLE_DIR" && $PNPM install --prod --ignore-workspace --lockfile=false --config.node-linker=hoisted )
rm -f "$BUNDLE_DIR/.npmrc"

echo "==> Writing final package.json (entry point for install.sh's service unit)"
cp "apps/gateway/package.json" "$BUNDLE_DIR/package.json"

echo "==> Packing $TARBALL"
mkdir -p "$(dirname "$TARBALL")"
rm -f "$TARBALL"
tar -czf "$TARBALL" -C "$OUT_DIR" gateway-bundle

echo "==> Sanity check: booting the bundle standalone"
( cd "$BUNDLE_DIR" && node -e "import('./dist/main.js')" ) 2>&1 | head -n5 || true

echo
echo "Done: $TARBALL"
echo "Copy it next to installer/install.sh and installer/README.md to ship a full bundle."
