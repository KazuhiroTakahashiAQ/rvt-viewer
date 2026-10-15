#!/usr/bin/env bash
# Build the rvt-rs WebAssembly bindings (wasm/, on top of ../rvt-rs) into src/wasm/pkg.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
CRATE="$ROOT/wasm"
OUT="$ROOT/src/wasm/pkg"
RVT_RS="$ROOT/../rvt-rs"
REPOSITORY="$(sed -n 's/^repository=//p' "$ROOT/rvt-rs.ref")"
COMMIT="$(sed -n 's/^commit=//p' "$ROOT/rvt-rs.ref")"

if [ ! -f "$RVT_RS/Cargo.toml" ]; then
  echo "../rvt-rs is missing. Clone it beside this repository:" >&2
  echo "  git clone https://github.com/$REPOSITORY.git \"$RVT_RS\"" >&2
  echo "  git -C \"$RVT_RS\" checkout $COMMIT" >&2
  exit 1
fi
HEAD="$(git -C "$RVT_RS" rev-parse HEAD 2>/dev/null || echo unknown)"
if [ "$HEAD" != "$COMMIT" ]; then
  echo "warning: ../rvt-rs is at $HEAD, rvt-rs.ref pins $COMMIT" >&2
fi

wasm-pack build "$CRATE" --release --target web --out-dir "$OUT" --out-name rvt --no-pack
rm -f "$OUT/.gitignore"
ls -l "$OUT"
