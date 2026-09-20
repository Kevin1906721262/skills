#!/bin/bash
# setclip.swift 的按需编译包装:首次调用编译到缓存目录,之后直接复用。
# 用法同 setclip.swift:setclip.sh html <htmlFile> [textFile]
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/setclip.swift"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/feishu-doc-edit"
BIN="$CACHE/setclip"

mkdir -p "$CACHE"
if [ ! -x "$BIN" ] || [ "$SRC" -nt "$BIN" ]; then
  command -v swiftc >/dev/null || { echo "需要 swiftc(Command Line Tools):xcode-select --install" >&2; exit 1; }
  swiftc -O "$SRC" -o "$BIN.tmp" >/dev/null
  mv "$BIN.tmp" "$BIN"
fi

exec "$BIN" "$@"
