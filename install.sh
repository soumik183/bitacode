#!/usr/bin/env sh
# Bitacode installer.
#
# Default: install the published package with npm (fast path).
# --source: download the latest GitHub release source tarball and install it
#           locally with npm (useful when the npm registry is blocked).
#
# Usage:
#   sh install.sh
#   sh install.sh --source
#   VERSION=v0.1.25 sh install.sh --source
#
# Remote:
#   curl -fsSL https://raw.githubusercontent.com/soumik183/bitacode/main/install.sh | sh

set -eu

REPO="soumik183/bitacode"
PKG="bitacode"
VERSION="${VERSION:-latest}"
MODE="npm"

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Options:
  --npm       Install from the npm registry (default)
  --source    Download the GitHub release source tarball and build with npm
  --version V Install a specific version/tag (or set VERSION=V)
  -h, --help  Show this help

Environment:
  VERSION     Version/tag to install (default: latest)
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --npm) MODE="npm" ;;
    --source) MODE="source" ;;
    --version)
      shift
      [ "$#" -gt 0 ] || { echo "error: --version needs a value" >&2; exit 1; }
      VERSION="$1"
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
  shift
done

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "error: '$1' is required but not installed" >&2
    exit 1
  }
}

download() {
  url="$1"
  out="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$out"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$out" "$url"
  else
    echo "error: curl or wget is required to download the source" >&2
    exit 1
  fi
}

resolve_tag() {
  if [ "$VERSION" != "latest" ]; then
    printf '%s\n' "$VERSION"
    return
  fi
  if command -v curl >/dev/null 2>&1; then
    tag=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" |
      sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
  elif command -v wget >/dev/null 2>&1; then
    tag=$(wget -qO- "https://api.github.com/repos/${REPO}/releases/latest" |
      sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
  else
    echo "error: curl or wget is required to resolve the latest release" >&2
    exit 1
  fi
  [ -n "$tag" ] || { echo "error: could not resolve the latest release tag" >&2; exit 1; }
  printf '%s\n' "$tag"
}

install_from_npm() {
  need_cmd npm
  spec="$PKG"
  version="$VERSION"
  if [ "$version" = "latest" ]; then
    version=$(npm view "$PKG" version 2>/dev/null || true)
  fi
  if [ -n "$version" ] && [ "$version" != "latest" ]; then
    # npm versions have no leading `v`; GitHub tags do.
    version=$(printf '%s\n' "$version" | sed 's/^v//')
    spec="$PKG@$version"
  fi
  echo "==> Installing $spec from npm"
  npm install -g "$spec"
}

install_from_source() {
  need_cmd npm
  need_cmd tar
  tag=$(resolve_tag)
  echo "==> Downloading ${REPO} source (${tag})"
  tmp=$(mktemp -d 2>/dev/null || mktemp -d -t bitacode-install)
  trap 'rm -rf "$tmp"' EXIT HUP INT TERM
  archive="$tmp/source.tar.gz"
  download "https://github.com/${REPO}/archive/refs/tags/${tag}.tar.gz" "$archive"
  tar -xzf "$archive" -C "$tmp"
  src=$(find "$tmp" -maxdepth 1 -type d -name 'bitacode-*' | head -n 1)
  [ -n "$src" ] || { echo "error: extracted source not found" >&2; exit 1; }
  echo "==> Building and installing from $src"
  (cd "$src" && npm install -g .)
}

if [ "$MODE" = "source" ]; then
  install_from_source
else
  install_from_npm
fi

echo
echo "Bitacode installed. Run: bitacode"
echo "Configure a provider with: bitacode configure"
