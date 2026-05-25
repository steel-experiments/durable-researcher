#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[setup]${NC} $*"; }
warn()  { echo -e "${YELLOW}[setup]${NC} $*"; }
error() { echo -e "${RED}[setup]${NC} $*" >&2; exit 1; }

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
ABSURDCTL_VERSION="0.3.0"
ABSURDCTL_URL="https://github.com/earendil-works/absurd/releases/download/${ABSURDCTL_VERSION}/absurdctl"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-postgres}"
DB_PASS="${DB_PASS:-postgres}"
DB_NAME="${DB_NAME:-absurd}"
DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
ABSURDCTL_BIN="${PROJECT_ROOT}/absurdctl"

if [[ ! "${DB_NAME}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
  error "DB_NAME must be a simple PostgreSQL identifier (letters, numbers, underscore; not starting with a number)."
fi

# ── 1. Check prerequisites ──────────────────────────────────────────────

info "Checking prerequisites..."

command -v bun >/dev/null 2>&1   || error "bun is not installed. Install from https://bun.sh"
command -v docker >/dev/null 2>&1 || error "docker is not installed. Install from https://docker.com"

# ── 2. Install dependencies ─────────────────────────────────────────────

info "Installing npm dependencies..."
bun install

# ── 3. Create .env if missing ────────────────────────────────────────────

if [ ! -f "${PROJECT_ROOT}/.env" ]; then
  cp "${PROJECT_ROOT}/.env.example" "${PROJECT_ROOT}/.env"
  info "Created .env from .env.example — edit it to add your API keys."
else
  info ".env already exists, skipping."
fi

# Check for required API keys
source_env() {
  # shellcheck disable=SC1090
  [ -f "${PROJECT_ROOT}/.env" ] && set -a && . "${PROJECT_ROOT}/.env" && set +a
}
source_env

if [ -z "${STEEL_API_KEY:-}" ]; then
  warn "STEEL_API_KEY is not set. Set it in .env before running the agent."
fi

# ── 4. Start Postgres ────────────────────────────────────────────────────

info "Starting Postgres via Docker..."
docker compose -f "${PROJECT_ROOT}/docker-compose.yml" up -d

# Wait for Postgres to be ready
info "Waiting for Postgres to accept connections..."
for i in $(seq 1 30); do
  if docker compose -f "${PROJECT_ROOT}/docker-compose.yml" exec -T postgres pg_isready -U "${DB_USER}" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! docker compose -f "${PROJECT_ROOT}/docker-compose.yml" exec -T postgres pg_isready -U "${DB_USER}" >/dev/null 2>&1; then
  error "Postgres is not responding after 30 seconds."
fi
info "Postgres is ready."

# ── 5. Create database ──────────────────────────────────────────────────

info "Creating database ${DB_NAME} if it doesn't exist..."
DB_EXISTS="$(docker compose -f "${PROJECT_ROOT}/docker-compose.yml" exec -T postgres psql -U "${DB_USER}" -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" 2>/dev/null || true)"
if [ "${DB_EXISTS}" != "1" ]; then
  docker compose -f "${PROJECT_ROOT}/docker-compose.yml" exec -T postgres psql -U "${DB_USER}" -d postgres -c "CREATE DATABASE \"${DB_NAME}\";"
  info "Database ${DB_NAME} created."
fi

# ── 6. Install absurdctl ────────────────────────────────────────────────

if [ ! -x "${ABSURDCTL_BIN}" ]; then
  info "Downloading absurdctl v${ABSURDCTL_VERSION}..."
  curl -sL "${ABSURDCTL_URL}" -o "${ABSURDCTL_BIN}"
  chmod +x "${ABSURDCTL_BIN}"
else
  info "absurdctl already installed."
fi

# ── 7. Initialize Absurd schema ─────────────────────────────────────────

info "Initializing Absurd schema..."
ABSURD_DATABASE_URL="${DATABASE_URL}" "${ABSURDCTL_BIN}" schema-version >/dev/null 2>&1 && {
  info "Schema already initialized."
} || {
  ABSURD_DATABASE_URL="${DATABASE_URL}" "${ABSURDCTL_BIN}" init
  info "Schema initialized."
}

info "Creating default queue..."
ABSURD_DATABASE_URL="${DATABASE_URL}" "${ABSURDCTL_BIN}" create-queue default >/dev/null 2>&1 || true

# ── 8. Setup eval (optional) ────────────────────────────────────────────

if [ -d "${PROJECT_ROOT}/eval" ]; then
  if command -v uv >/dev/null 2>&1; then
    info "Setting up eval dependencies..."
    (cd "${PROJECT_ROOT}/eval" && uv sync --dev 2>/dev/null) \
      || warn "Eval setup failed. Run 'cd eval && uv sync --dev' manually."
  else
    warn "uv is not installed. Skipping eval setup. Install from https://docs.astral.sh/uv/"
  fi
fi

# ── Done ─────────────────────────────────────────────────────────────────

echo ""
info "Setup complete!"
echo ""
echo "  Next steps:"
echo "    1. Edit .env and add your API keys (STEEL_API_KEY, ZAI_API_KEY)"
echo "    2. Run a research task:"
echo "       bun run dev \"your research topic\""
echo ""
