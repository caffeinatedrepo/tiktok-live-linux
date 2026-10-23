#!/usr/bin/env sh
# Install the `ttlive` command for the current user.
#
#   ./install.sh                 -> ~/.local/bin/ttlive
#   PREFIX=/usr/local ./install.sh (as root)
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TARGET="$ROOT/bin/ttlive.js"
PREFIX="${PREFIX:-$HOME/.local/bin}"

if ! command -v node >/dev/null 2>&1; then
  echo "error: node not found (Node.js 20 or newer is required)" >&2
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "warning: ffmpeg is not on PATH - install it before streaming" >&2
fi

mkdir -p "$PREFIX"
chmod +x "$TARGET"
ln -sf "$TARGET" "$PREFIX/ttlive"

echo "installed: $PREFIX/ttlive"

case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *)
    echo
    echo "add this to your shell profile:"
    echo "  export PATH=\"$PREFIX:\$PATH\""
    ;;
esac
