#!/usr/bin/env python3
"""Run the local Claude Code CLI in its own pty and bring the reply back verbatim.

The pty stays detached from the caller's terminal, and the answer is read from
Claude Code's own JSONL transcript, which also records the model that answered.
"""

import argparse
import fcntl
import glob
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

DEFAULT_CLAUDE = "/usr/local/bin/claude"
PROJECTS_DIR = os.path.expanduser("~/.claude/projects")

ANSI_CSI = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]")
ANSI_OSC = re.compile(r"\x1b\][^\x07\x1b]*(\x07|\x1b\\)")
ANSI_CHARSET = re.compile(r"\x1b[()][A-Za-z0-9]")


def strip_ansi(text):
    text = ANSI_CSI.sub("", text)
    text = ANSI_OSC.sub("", text)
    text = ANSI_CHARSET.sub("", text)
    return text.replace("\r", "")


def snapshot_transcripts():
    return set(glob.glob(os.path.join(PROJECTS_DIR, "*", "*.jsonl")))


def read_records(path):
    records = []
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except OSError:
        pass
    return records


def block_text(content):
    if isinstance(content, str):
        return content
    parts = []
    for block in content or []:
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(block.get("text", ""))
    return "\n".join(parts)


class Driver:
    def __init__(self, claude, cwd, boot_seconds, settle_seconds):
        self.cwd = os.path.realpath(cwd)
        self.boot_seconds = boot_seconds
        self.settle_seconds = settle_seconds
        self.before = snapshot_transcripts()
        self.buf = bytearray()
        self.started_at = time.time()

        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        env = dict(os.environ)
        env["TERM"] = "xterm-256color"
        self.proc = subprocess.Popen(
            [claude],
            cwd=self.cwd,
            env=env,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            start_new_session=True,
        )
        os.close(slave)
        self.master = master

    def drain(self, seconds):
        deadline = time.time() + seconds
        while time.time() < deadline:
            ready, _, _ = select.select([self.master], [], [], 0.2)
            if not ready:
                continue
            try:
                chunk = os.read(self.master, 65536)
            except OSError:
                return
            if not chunk:
                return
            self.buf.extend(chunk)

    def boot(self):
        """Wait for the TUI to come up and stop redrawing before typing."""
        deadline = time.time() + self.boot_seconds
        size = len(self.buf)
        quiet_since = None
        while time.time() < deadline:
            self.drain(0.5)
            if len(self.buf) != size:
                size = len(self.buf)
                quiet_since = time.time()
            elif quiet_since and time.time() - quiet_since >= self.settle_seconds:
                return True
        return len(self.buf) > 0

    def send(self, text, delay=1.0):
        os.write(self.master, text.encode("utf-8"))
        time.sleep(delay)

    def new_transcripts(self):
        fresh = sorted(
            set(glob.glob(os.path.join(PROJECTS_DIR, "*", "*.jsonl"))) - self.before,
            key=os.path.getmtime,
        )
        if not fresh:
            return []
        matched = []
        for path in fresh:
            records = read_records(path)
            if any(rec.get("cwd") == self.cwd for rec in records):
                matched.append(path)
        return matched or fresh

    def wait_for_command(self, needle, timeout):
        deadline = time.time() + timeout
        while time.time() < deadline:
            self.drain(1.0)
            for path in self.new_transcripts():
                records = read_records(path)
                for rec in records:
                    body = block_text((rec.get("message") or {}).get("content"))
                    if needle in body:
                        return path, records
        return None, []

    def wait_for_reply(self, timeout):
        deadline = time.time() + timeout
        while time.time() < deadline:
            self.drain(2.0)
            for path in self.new_transcripts():
                for rec in read_records(path):
                    if rec.get("type") != "assistant":
                        continue
                    message = rec.get("message") or {}
                    if message.get("role") != "assistant":
                        continue
                    text = block_text(message.get("content")).strip()
                    if text:
                        return path, text, message.get("model")
        return None, None, None

    def close(self):
        try:
            self.send("/exit")
        except OSError:
            pass
        try:
            os.killpg(os.getpgid(self.proc.pid), signal.SIGTERM)
        except (OSError, ProcessLookupError):
            pass
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(os.getpgid(self.proc.pid), signal.SIGKILL)
            except (OSError, ProcessLookupError):
                pass
        self.drain(1.0)
        try:
            os.close(self.master)
        except OSError:
            pass


def model_confirmation(records):
    requested = None
    ack = None
    for rec in records:
        body = block_text((rec.get("message") or {}).get("content"))
        if "<command-name>/model</command-name>" in body:
            match = re.search(r"<command-args>(.*?)</command-args>", body, re.S)
            if match and match.group(1).strip():
                requested = match.group(1).strip()
        if "<local-command-stdout>" in body:
            ack = re.sub(r"</?local-command-stdout>", "", body).strip()
    return requested, ack


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prompt", required=True, help="task text to send to claude")
    parser.add_argument("--model", help="send `/model <name>` before the prompt")
    parser.add_argument("--cwd", default=os.getcwd(), help="working directory for the session")
    parser.add_argument("--claude", default=DEFAULT_CLAUDE)
    parser.add_argument("--boot-seconds", type=float, default=45.0)
    parser.add_argument("--settle-seconds", type=float, default=3.0)
    parser.add_argument("--timeout", type=float, default=300.0, help="seconds to wait for the reply")
    parser.add_argument("--raw-log", help="where to write the stripped TUI output")
    args = parser.parse_args()

    if not os.path.exists(args.claude):
        sys.exit("claude not found at %s" % args.claude)

    raw_log = args.raw_log or "/tmp/claude-pty-run-%d.log" % int(time.time())
    driver = Driver(args.claude, args.cwd, args.boot_seconds, args.settle_seconds)

    report = []
    model_ack = None
    reply = None
    reply_model = None
    transcript = None

    try:
        booted = driver.boot()
        report.append("boot: %s" % ("settled" if booted else "no output seen"))

        if args.model:
            for attempt in (1, 2):
                driver.send("/model %s" % args.model, delay=0.5)
                driver.send("\r", delay=0.5)
                transcript, records = driver.wait_for_command(
                    "<command-name>/model</command-name>", 25
                )
                _, model_ack = model_confirmation(records)
                report.append(
                    "model command attempt %d: %s" % (attempt, model_ack or "no transcript entry")
                )
                if model_ack:
                    break

        driver.send(args.prompt, delay=0.5)
        driver.send("\r", delay=0.5)
        report.append("prompt sent: %s" % args.prompt.replace("\n", " ")[:120])

        transcript, reply, reply_model = driver.wait_for_reply(args.timeout)
    finally:
        driver.close()

    plain = strip_ansi(driver.buf.decode("utf-8", "replace"))
    with open(raw_log, "w", encoding="utf-8") as handle:
        handle.write(plain)

    print("\n=== steps ===")
    for line in report:
        print(line)
    if model_ack:
        print("\n=== model switch confirmation ===")
        print(model_ack)
    print("\n=== answering model ===")
    print(reply_model or "(unknown)")
    print("\n=== reply ===")
    print(reply if reply else "(no assistant reply captured)")
    print("\n=== transcript ===")
    print(transcript or "(none)")
    print("\n=== raw TUI log ===")
    print(raw_log)

    if not reply:
        system_reminder = (
            "No reply captured: check the raw log above for the TUI state, "
            "raise --boot-seconds or --timeout, and rerun."
        )
        print("\n" + system_reminder)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
