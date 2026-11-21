#!/usr/bin/env bash
# Run onstreak's real-Postgres tests against a local Homebrew Postgres, starting
# it only when needed (no background service, no start at login).
#
#   npm run test:pg          start Postgres if it is not running, run every test
#                            against it, then stop it again if we started it
#   npm run pg:start         start it and leave it running
#   npm run pg:stop          stop it
#
# One-time setup:  brew install postgresql@16
# Already have a Postgres (Docker, remote)? Skip all this and run:
#   TEST_DATABASE_URL=postgres://user:pass@host:5432/db npm test
set -euo pipefail

if [ -n "${TEST_DATABASE_URL:-}" ] && [ "${1:-}" = "test" ]; then
  REQUIRE_POSTGRES=1 exec npm test
fi

command -v brew >/dev/null || { echo "Homebrew not found. Install Postgres yourself, then: TEST_DATABASE_URL=postgres://... npm test" >&2; exit 1; }
PREFIX="$(brew --prefix)"
BIN="$PREFIX/opt/postgresql@16/bin"
DATA="$PREFIX/var/postgresql@16"
LOG="$PREFIX/var/log/postgresql@16.log"
URL="postgres://${USER}@localhost:5432/postgres"

[ -x "$BIN/pg_ctl" ] || { echo "postgresql@16 is not installed. Run: brew install postgresql@16" >&2; exit 1; }

running() { "$BIN/pg_isready" -q -h localhost -p 5432; }

start() {
  if running; then echo "Postgres is already running."; return; fi
  # Postgres refuses to start without a valid locale.
  LC_ALL="en_US.UTF-8" "$BIN/pg_ctl" -D "$DATA" -l "$LOG" -w start >/dev/null
  echo "Postgres started (log: $LOG)"
}

stop() {
  "$BIN/pg_ctl" -D "$DATA" -m fast stop >/dev/null 2>&1 && echo "Postgres stopped." || echo "Postgres was not running."
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) running && echo "running" || echo "stopped" ;;
  test)
    started=0
    if ! running; then start; started=1; fi
    cleanup() { [ "$started" = 1 ] && stop || true; }
    trap cleanup EXIT
    TEST_DATABASE_URL="$URL" REQUIRE_POSTGRES=1 npm test
    ;;
  *) echo "usage: bash scripts/pg.sh start|stop|status|test" >&2; exit 2 ;;
esac
