#!/bin/sh
# Type-check without installing dependencies in the extension directory: Pi
# loads this directory, and a physical copy of Pi's own packages next to it
# can bypass Pi's extension module mapping (Pi docs: packages.md).
# Dependencies live in a cache directory; the sources are copied to a fresh
# temporary directory that links to them.
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
deps="${XDG_CACHE_HOME:-$HOME/.cache}/pi-codex-gateway-typecheck"
work=$(mktemp -d)

mkdir -p "$deps"
cp "$repo/package.json" "$deps/"
(cd "$deps" && bun install --silent)

cd "$repo"
git ls-files -z --cached --others --exclude-standard -- '*.ts' tsconfig.json package.json |
	xargs -0 cp --parents -t "$work"
ln -s "$deps/node_modules" "$work/node_modules"

cd "$work"
exec "$deps/node_modules/.bin/tsc" --noEmit -p .
