#!/usr/bin/env bash
set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/absurd}"
ABSURDCTL="${ABSURDCTL:-}"
ABSURDCTL_VERSION="${ABSURDCTL_VERSION:-0.3.0}"
ABSURDCTL_URL="${ABSURDCTL_URL:-https://github.com/earendil-works/absurd/releases/download/${ABSURDCTL_VERSION}/absurdctl}"

if [ -z "${ABSURDCTL}" ]; then
  if [ -x "./absurdctl" ]; then
    ABSURDCTL="./absurdctl"
  elif command -v absurdctl >/dev/null 2>&1; then
    ABSURDCTL="$(command -v absurdctl)"
  elif command -v curl >/dev/null 2>&1; then
    echo "absurdctl not found; downloading v${ABSURDCTL_VERSION} to ./absurdctl"
    curl -fsSL "${ABSURDCTL_URL}" -o ./absurdctl
    chmod +x ./absurdctl
    ABSURDCTL="./absurdctl"
  else
    echo "Error: absurdctl not found and curl is unavailable. Run ./setup.sh first or set ABSURDCTL=/path/to/absurdctl." >&2
    exit 1
  fi
fi

export ABSURD_DATABASE_URL="${DATABASE_URL}"

if "${ABSURDCTL}" schema-version >/dev/null 2>&1; then
  echo "Schema already initialized"
else
  "${ABSURDCTL}" init
fi

"${ABSURDCTL}" create-queue default >/dev/null 2>&1 || true
echo "Done"
