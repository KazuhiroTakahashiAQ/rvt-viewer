#!/usr/bin/env bash
# Build the rvt-rs WebAssembly bindings (wasm/, on top of vendor/rvt-rs) into src/wasm/pkg.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CRATE="$ROOT/wasm"
OUT="$ROOT/src/wasm/pkg"

if [ ! -f "$ROOT/vendor/rvt-rs/Cargo.toml" ]; then
  echo "vendor/rvt-rs is missing. Run: git submodule update --init" >&2
  exit 1
fi

wasm-pack build "$CRATE" --release --target web --out-dir "$OUT" --out-name rvt --no-pack
rm -f "$OUT/.gitignore"
ls -l "$OUT"
