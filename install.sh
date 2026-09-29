#!/usr/bin/env bash
set -euo pipefail

# Install Flex from a clone without making destructive system changes.
# The script prefers Corepack/pnpm, builds the checked-out package, then uses
# pnpm's user-level global link. If that is unavailable it installs a local
# launcher in ~/.local/bin and tells the user how to add it to PATH.

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
MIN_NODE_MAJOR=22
FLEX_BIN="$HOME/.local/bin/flex"

info() { printf 'flex install: %s\n' "$*"; }
warn() { printf 'flex install: warning: %s\n' "$*" >&2; }
fatal() { printf 'flex install: error: %s\n' "$*" >&2; exit 1; }

case "$(uname -s 2>/dev/null || printf unknown)" in
  Linux) info "detected Linux" ;;
  Darwin) info "detected macOS" ;;
  *) warn "this platform is not officially supported; continuing because Node may still work" ;;
esac

command -v git >/dev/null 2>&1 || fatal "Git is required. Install Git and run ./install.sh again."
command -v node >/dev/null 2>&1 || fatal "Node.js ${MIN_NODE_MAJOR}+ is required. Install it and run ./install.sh again."

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
  fatal "Node.js ${MIN_NODE_MAJOR}+ is required; found $(node --version)."
fi
info "using $(node --version)"

# Prefer a system pnpm, then Corepack. Corepack is enabled only when possible;
# failure here is non-fatal because `corepack pnpm` can still run directly.
if command -v pnpm >/dev/null 2>&1; then
  PNPM=(pnpm)
elif command -v corepack >/dev/null 2>&1; then
  info "pnpm was not found; enabling Corepack"
  corepack enable >/dev/null 2>&1 || warn "could not write Corepack shims; using corepack pnpm directly"
  PNPM=(corepack pnpm)
else
  command -v npm >/dev/null 2>&1 || fatal "pnpm/Corepack/npm are unavailable. Install Node.js with Corepack enabled."
  info "Corepack is unavailable; using npm exec for a temporary pnpm"
  PNPM=(npm exec --yes --package=pnpm@12 -- pnpm)
fi

cd "$ROOT_DIR"
info "installing dependencies from the lockfile"
"${PNPM[@]}" install --frozen-lockfile
info "building Flex"
"${PNPM[@]}" build

# A normal pnpm global link is preferred because it also exposes the package
# metadata and bin entry. It never uses sudo. The fallback is a user-owned
# symlink to the built CLI and is safe to rerun.
LINKED=0
if "${PNPM[@]}" link --global >/dev/null 2>&1; then
  LINKED=1
  info "linked flex through pnpm's user/global package directory"
else
  warn "pnpm global linking was unavailable; creating a user-local launcher"
  mkdir -p "$(dirname "$FLEX_BIN")"
  ln -sfn "$ROOT_DIR/dist/cli/main.js" "$FLEX_BIN"
  chmod +x "$ROOT_DIR/dist/cli/main.js"
  info "created $FLEX_BIN"
fi

# Verify from a directory outside the repository so accidental source-relative
# imports or cwd assumptions are caught here rather than after installation.
VERIFY_PATH="$PATH"
if [ "$LINKED" -eq 0 ]; then VERIFY_PATH="$(dirname "$FLEX_BIN"):$VERIFY_PATH"; fi
if ! (cd "${TMPDIR:-/tmp}" && PATH="$VERIFY_PATH" flex --help >/dev/null); then
  if [ "$LINKED" -eq 1 ]; then
    fatal "the global link was created but flex --help failed outside the repository"
  fi
  fatal "the user-local launcher was created but flex --help failed"
fi

info "installation verified: flex --help"
if [ "$LINKED" -eq 0 ] && ! command -v flex >/dev/null 2>&1; then
  printf '\nAdd this directory to your shell PATH, then restart your shell:\n  export PATH="$HOME/.local/bin:$PATH"\n\n'
fi
printf 'Flex is ready. Run: flex\n'
