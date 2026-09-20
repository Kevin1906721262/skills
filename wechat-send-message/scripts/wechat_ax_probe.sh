#!/bin/bash
# Inspect WeChat (Mac) accessibility state: window geometry and every AXTextArea with its
# name, value and screen rect. Run this before trusting any hard-coded UI path.
# Usage: wechat_ax_probe.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

pgrep -f "/Applications/WeChat.app/Contents/MacOS/WeChat" >/dev/null 2>&1 || {
  echo "WeChat is not running." >&2
  exit 2
}

osascript "$SCRIPT_DIR/wechat_ax.applescript" probe
