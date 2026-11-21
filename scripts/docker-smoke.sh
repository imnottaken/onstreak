#!/usr/bin/env bash
# End-to-end check of the Docker setup: build, start, track, restart, stop.
# Used by CI; runs locally too if Docker is installed.
set -euo pipefail
cd "$(dirname "$0")/.."

KEY="change-me-to-a-long-secret"
URL="http://localhost:8787"
compose() { docker compose "$@"; }
fail() { echo "FAIL: $*" >&2; compose logs --no-color >&2 || true; exit 1; }
cleanup() { compose down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

wait_healthy() {
  for _ in $(seq 1 60); do
    if curl -fsS "$URL/health" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  fail "server did not become healthy"
}

cleanup
echo "--- build and start"
compose up -d --build
wait_healthy
curl -fsS "$URL/health" | grep -q '"database":"ok"' || fail "health does not report the database"

echo "--- unauthenticated requests are refused"
code=$(curl -s -o /dev/null -w '%{http_code}' "$URL/v1/users/smoke")
[ "$code" = "401" ] || fail "expected 401 without a key, got $code"

echo "--- track an event"
out=$(curl -fsS -X POST "$URL/v1/events" -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"userId":"smoke","event":"lesson_completed"}')
echo "$out" | grep -q '"total":10' || fail "unexpected track result: $out"

echo "--- data survives a container restart"
compose restart onstreak
wait_healthy
out=$(curl -fsS "$URL/v1/users/smoke" -H "authorization: Bearer $KEY")
echo "$out" | grep -q '"xp":10' || fail "points were lost on restart: $out"

echo "--- container reports healthy"
id=$(compose ps -q onstreak)
for _ in $(seq 1 30); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$id")
  [ "$status" = "healthy" ] && break
  sleep 2
done
[ "$status" = "healthy" ] || fail "docker health status is $status"

echo "--- runs as a non-root user"
user=$(docker exec "$id" id -u)
[ "$user" != "0" ] || fail "container runs as root"

echo "--- stops gracefully"
compose stop -t 20 onstreak
compose logs --no-color onstreak | grep -q '"msg":"stopped"' || fail "no graceful stop in the logs"
exit_code=$(docker inspect -f '{{.State.ExitCode}}' "$id")
[ "$exit_code" = "0" ] || fail "container exited with $exit_code"

echo "docker smoke test passed"
