#!/usr/bin/env bash
# Starts the dev server (if it isn't already running) and opens one browser
# window per player, each automatically creating/joining the same game,
# taking a seat, and (once everyone's seated) starting it — no manual
# clicking required. Relies on the `autocreate`/`autojoin`/`autoseat`/
# `autostart` query params wired up in src/app/page.tsx and
# src/app/game/[id]/page.tsx.
#
# Usage:
#   scripts/launch-multiplayer.sh [Name1 Name2 ...]
#
# Name1 becomes the host (creates the game); the rest join it. Defaults to
# three players (Alice, Bob, Carol) if none are given.

set -euo pipefail

PORT="${PORT:-3000}"
BASE="http://localhost:${PORT}"
PLAYERS=("$@")
if [ ${#PLAYERS[@]} -eq 0 ]; then
  PLAYERS=(Alice Bob Carol)
fi
TOTAL=${#PLAYERS[@]}

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

urlencode() {
  local s="$1" out="" c i
  local length="${#s}"
  for (( i = 0; i < length; i++ )); do
    c="${s:i:1}"
    case "$c" in
      [a-zA-Z0-9.~_-]) out+="$c" ;;
      *) out+=$(printf '%%%02X' "'$c") ;;
    esac
  done
  printf '%s' "$out"
}

open_window() {
  local url="$1"
  if [ -d "/Applications/Google Chrome.app" ]; then
    open -na "Google Chrome" --args --new-window "$url"
  elif [ -d "/Applications/Microsoft Edge.app" ]; then
    open -na "Microsoft Edge" --args --new-window "$url"
  elif [ -d "/Applications/Brave Browser.app" ]; then
    open -na "Brave Browser" --args --new-window "$url"
  else
    open "$url"
  fi
}

if ! curl -s -o /dev/null "$BASE"; then
  echo "Starting dev server on port $PORT..."
  LOG_FILE="${TMPDIR:-/tmp}/threejs-dev-server.log"
  (npm run dev >"$LOG_FILE" 2>&1 &)
  echo "  (logging to $LOG_FILE)"
  for _ in $(seq 1 60); do
    if curl -s -o /dev/null "$BASE"; then break; fi
    sleep 0.5
  done
  if ! curl -s -o /dev/null "$BASE"; then
    echo "Server didn't come up in time — check $LOG_FILE" >&2
    exit 1
  fi
fi

GAME_ID="DEV$(( (RANDOM % 900) + 100 ))"
HOST="${PLAYERS[0]}"

echo "Game code: $GAME_ID"
echo "Host: $HOST"

HOST_URL="${BASE}/?autocreate=1&name=$(urlencode "$HOST")&gameId=${GAME_ID}&autoseat=1&autostart=1&expect=${TOTAL}"
open_window "$HOST_URL"

# Give the host a beat to create the room before joiners start hammering it
# — autojoin retries anyway, so this is just to cut down on retry noise.
sleep 1

for name in "${PLAYERS[@]:1}"; do
  JOIN_URL="${BASE}/game/${GAME_ID}?autojoin=1&name=$(urlencode "$name")&autoseat=1"
  open_window "$JOIN_URL"
  sleep 0.4
done

echo "Opened ${TOTAL} windows for game ${GAME_ID}: ${PLAYERS[*]}"
