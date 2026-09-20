#!/bin/bash
# ===========================================================
#  Browser CDP launcher (macOS) -- Chrome if installed, else Edge.
#
#  THE POINT: your everyday browser and the CDP-driven browser
#  are ONE AND THE SAME, on ONE AND THE SAME profile. Login
#  state is therefore shared; nothing needs logging in twice.
#
#  Usage:
#    ./launch-macos.sh                 # start with port 9222
#    ./launch-macos.sh https://x.com   # also open a URL
#    CDP_PORT=9223 CDP_PROFILE="$HOME/.browser-isolated" ./launch-macos.sh
#
#  Behaviour:
#    1. debug port already up        -> just open a window
#    2. browser running WITHOUT it   -> restart it (see [warn] below)
#    3. otherwise                    -> start with the port
# ===========================================================
set -u

PORT="${CDP_PORT:-9222}"
PROFILE_OVERRIDE="${CDP_PROFILE:-}"

# --- candidate browsers: executable | default profile dir | process name ---
CANDIDATES=(
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome|$HOME/Library/Application Support/Google/Chrome|Google Chrome"
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge|$HOME/Library/Application Support/Microsoft Edge|Microsoft Edge"
)

BROWSER=""; PROFILE=""; PROC=""
for c in "${CANDIDATES[@]}"; do
  IFS='|' read -r exe prof pname <<< "$c"
  if [ -x "$exe" ]; then
    BROWSER="$exe"; PROFILE="$prof"; PROC="$pname"; break
  fi
done

if [ -z "$BROWSER" ]; then
  echo "[ERROR] Neither Chrome nor Edge found in /Applications." >&2
  echo "        Install one, then rerun." >&2
  exit 1
fi

[ -n "$PROFILE_OVERRIDE" ] && PROFILE="$PROFILE_OVERRIDE"

echo "[..] Browser : $BROWSER"
echo "[..] Profile : $PROFILE"

# Launch detached, with output discarded. Redirecting matters: if the browser
# inherits a pipe (e.g. the caller did `./launch-macos.sh | tail`), the pipe
# never sees EOF and the caller hangs forever.
launch() {
  nohup "$BROWSER" --user-data-dir="$PROFILE" --remote-debugging-port="$PORT" "$@" \
    >/dev/null 2>&1 &
  disown 2>/dev/null || true
}

# --- 1. is the debug port already up? ---
#     (the port flag is passed again anyway: harmless when handing off to a
#      live instance, and correct if that instance died in the meantime)
if curl -s --max-time 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  echo "[ok] Debug port $PORT is already up. Opening a window."
  launch "$@"
  exit 0
fi

# --- 2. browser running without the port? it must be restarted ---
if pgrep -x "$PROC" >/dev/null 2>&1; then
  echo "[warn] $PROC is running WITHOUT a debug port. Restarting it."
  echo "       Its windows will close; the browser restores tabs on reopen."
  pkill -x "$PROC" 2>/dev/null
  # give it up to ~10s to exit cleanly, then escalate
  for _ in $(seq 1 20); do
    pgrep -x "$PROC" >/dev/null 2>&1 || break
    sleep 0.5
  done
  if pgrep -x "$PROC" >/dev/null 2>&1; then
    echo "[warn] still running, escalating to SIGKILL"
    pkill -9 -x "$PROC" 2>/dev/null
    sleep 2
  fi
fi

# --- 3. start with the port ---
echo "[..] Starting with CDP debug port $PORT ..."
launch --no-first-run --no-default-browser-check "$@"
