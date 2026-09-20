#!/bin/bash
# Send one text message to a WeChat (Mac) contact by driving the GUI with AppleScript.
# Usage: send_wechat_message.sh <recipient> <message> [--dry-run]
# Exit codes: 0 ok | 2 WeChat not running | 3 chat did not open / title mismatch
#             4 draft verification failed | 5 send verification failed | 1 usage/environment error
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AX="$SCRIPT_DIR/wechat_ax.applescript"

RECIPIENT="${1:-}"
MESSAGE="${2:-}"
DRY_RUN=0
[ "${3:-}" = "--dry-run" ] && DRY_RUN=1

if [ -z "$RECIPIENT" ] || [ -z "$MESSAGE" ]; then
  echo "usage: $0 <recipient> <message> [--dry-run]" >&2
  exit 1
fi

# A pasted newline would fire the send key mid-message; keep this to single-line text.
case "$MESSAGE" in
  *$'\n'*) echo "message must be a single line (a pasted newline would send early)" >&2; exit 1 ;;
esac

pgrep -f "/Applications/WeChat.app/Contents/MacOS/WeChat" >/dev/null 2>&1 || {
  echo "WeChat is not running; start it (and make sure the user is logged in) first." >&2
  exit 2
}

CLIP_BAK="$(mktemp -t wxclip)"
if pbpaste >"$CLIP_BAK" 2>/dev/null; then :; else : >"$CLIP_BAK"; fi
restore_clip() { pbcopy <"$CLIP_BAK" 2>/dev/null; rm -f "$CLIP_BAK"; }
trap restore_clip EXIT

ax() { osascript "$AX" "$@" 2>&1; }
# "<name>\t<value>" -> the value alone.
draft_of() { ax dump "$1" | sed '1s/^[^\t]*\t//'; }

# 1. Bring WeChat forward and close any search overlay left over from a previous run.
osascript -e 'tell application "System Events" to tell process "WeChat" to set frontmost to true' >/dev/null 2>&1
ax esc >/dev/null 2>&1
sleep 0.4

# 2. Type the recipient into the search box (paste: keystroke mangles CJK into ASCII).
out="$(ax focus-paste "搜索" "$RECIPIENT")"
case "$out" in
  *ERR*) echo "could not focus the WeChat search box ($out)" >&2; exit 3 ;;
esac
sleep 1.6

# 3. Enter opens the top hit, which is the 联系人 (contact) entry when the name matches a contact.
ax enter >/dev/null 2>&1
sleep 1.8

# 4. Verify the right chat is open: WeChat names the message box after the open chat's title.
chat="$(ax dump "$RECIPIENT")"
case "$chat" in
  *ERR*) echo "chat '$RECIPIENT' did not open (message box not found); aborting before typing." >&2; exit 3 ;;
esac

# 5. Paste the message into the message box and prove the draft matches before sending.
out="$(ax focus-paste "$RECIPIENT" "$MESSAGE")"
case "$out" in
  *ERR*) echo "could not focus the message box for '$RECIPIENT'" >&2; exit 4 ;;
esac
sleep 0.6

draft="$(draft_of "$RECIPIENT")"
if [ "$draft" != "$MESSAGE" ]; then
  echo "draft mismatch: message box contains [$draft], expected [$MESSAGE]; not sending." >&2
  exit 4
fi

if [ "$DRY_RUN" = "1" ]; then
  echo "DRY RUN: chat '$RECIPIENT' open, draft verified [$draft]. Nothing sent."
  exit 0
fi

# 6. Send. Return is WeChat's default send key; fall back to Cmd+Return if the draft survives.
ax enter >/dev/null 2>&1
sleep 1.2
after="$(draft_of "$RECIPIENT")"
if [ "$after" = "$MESSAGE" ]; then
  ax enter-cmd >/dev/null 2>&1
  sleep 1.2
  after="$(draft_of "$RECIPIENT")"
fi
if [ "$after" = "$MESSAGE" ]; then
  echo "send failed: the draft is still sitting in the message box; check WeChat's send-key preference." >&2
  exit 5
fi

echo "sent to '$RECIPIENT': $MESSAGE"
