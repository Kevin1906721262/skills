#!/usr/bin/env python3
"""查询 DeepSeek 账户余额。

端点: GET https://api.deepseek.com/user/balance  (Authorization: Bearer <key>)

自动发现多个 API Key 并逐个查询（本机上 Claude Code 用的 key 和环境变量里的 key
往往是两个不同账号，只查一个会看错账）。

用法:
    deepseek_balance.py                 # 查询所有自动发现的 key
    deepseek_balance.py --key sk-xxx    # 只查指定的 key
    deepseek_balance.py --threshold 5   # 任一账户低于 5 元时退出码为 1
    deepseek_balance.py --json          # 输出原始 JSON，便于脚本消费
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

DEFAULT_BASE = "https://api.deepseek.com"
TIMEOUT = 20
SETTINGS_PATH = Path.home() / ".claude" / "settings.json"


def mask(key: str) -> str:
    """只显示前 8 位，避免完整 key 落到终端记录/日志里。"""
    return f"{key[:8]}…{key[-4:]}" if len(key) > 14 else f"{key[:6]}…"


def resolve_base_url() -> str:
    """余额端点在 api.deepseek.com 根路径下。

    本机 Claude Code 走的是 /anthropic 兼容端点，这里把后缀剥掉，
    这样将来换代理域名时能跟着走。
    """
    explicit = os.environ.get("DEEPSEEK_BASE_URL")
    if explicit:
        return explicit.rstrip("/")
    anthropic_base = os.environ.get("ANTHROPIC_BASE_URL", "")
    if "api.deepseek.com" in anthropic_base:
        return DEFAULT_BASE
    return DEFAULT_BASE


def discover_keys() -> list[tuple[str, str]]:
    """返回 [(来源标签, key), ...]，同一个 key 只保留第一次出现的来源。"""
    found: list[tuple[str, str]] = []

    env_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if env_key:
        found.append(("环境变量 DEEPSEEK_API_KEY", env_key))

    # Claude Code 实际发请求用的是 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY
    try:
        settings = json.loads(SETTINGS_PATH.read_text())
        env_block = settings.get("env", {})
        cc_key = (env_block.get("ANTHROPIC_AUTH_TOKEN") or env_block.get("ANTHROPIC_API_KEY") or "").strip()
        if cc_key:
            found.append(("Claude Code settings.json", cc_key))
    except FileNotFoundError:
        pass
    except (json.JSONDecodeError, OSError) as exc:
        print(f"⚠️  读取 {SETTINGS_PATH} 失败: {exc}", file=sys.stderr)

    seen: set[str] = set()
    deduped: list[tuple[str, str]] = []
    for label, key in found:
        if key not in seen:
            seen.add(key)
            deduped.append((label, key))
    return deduped


def query_balance(key: str, base_url: str, timeout: int) -> dict:
    """查一个 key 的余额。失败时抛出 RuntimeError，消息里已含可读原因。"""
    # 用 curl 而不是 urllib：本机的代理链证书只有 curl（走系统钥匙串）认，
    # python 自带 CA bundle 会报 CERTIFICATE_VERIFY_FAILED。
    proc = subprocess.run(
        [
            "curl", "-sS", "-L", "--max-time", str(timeout),
            "-w", "\n%{http_code}",
            "-H", "Accept: application/json",
            "-H", f"Authorization: Bearer {key}",
            f"{base_url}/user/balance",
        ],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"curl 失败({proc.returncode}): {proc.stderr.strip()[:200]}")

    body, _, status = proc.stdout.rpartition("\n")
    try:
        code = int(status.strip())
    except ValueError:
        raise RuntimeError(f"无法解析 HTTP 状态码，原始输出: {proc.stdout[:200]}") from None

    if code == 401:
        raise RuntimeError("401 鉴权失败 —— key 无效或已撤销")
    if code == 402:
        raise RuntimeError("402 余额不足")
    if code != 200:
        raise RuntimeError(f"HTTP {code}: {body.strip()[:200]}")

    try:
        return json.loads(body)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"响应不是合法 JSON: {exc}") from exc


def lowest_balance(infos: list[dict]) -> float:
    """多币种时取最小的 total_balance，用于阈值判断（保守）。"""
    totals = []
    for info in infos:
        try:
            totals.append(float(info.get("total_balance", 0)))
        except (TypeError, ValueError):
            continue
    return min(totals) if totals else 0.0


def main() -> int:
    parser = argparse.ArgumentParser(description="查询 DeepSeek 账户余额")
    parser.add_argument("--key", help="显式指定 API Key（不给则自动发现）")
    parser.add_argument("--threshold", type=float, help="任一账户低于该值时退出码为 1")
    parser.add_argument("--json", action="store_true", dest="as_json", help="输出原始 JSON")
    parser.add_argument("--timeout", type=int, default=TIMEOUT, help=f"请求超时秒数（默认 {TIMEOUT}）")
    args = parser.parse_args()

    base_url = resolve_base_url()
    targets = [("--key 参数", args.key)] if args.key else discover_keys()

    if not targets:
        print("❌ 没有找到任何 DeepSeek API Key。", file=sys.stderr)
        print("   设置环境变量 DEEPSEEK_API_KEY，或用 --key 显式传入。", file=sys.stderr)
        return 2

    results = []
    for label, key in targets:
        try:
            data = query_balance(key, base_url, args.timeout)
            results.append({"source": label, "key": mask(key), "ok": True, "data": data})
        except RuntimeError as exc:
            results.append({"source": label, "key": mask(key), "ok": False, "error": str(exc)})

    if args.as_json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
    else:
        print(f"端点: {base_url}/user/balance\n")
        for item in results:
            print(f"● {item['source']}  ({item['key']})")
            if not item["ok"]:
                print(f"  ❌ {item['error']}\n")
                continue
            data = item["data"]
            infos = data.get("balance_infos") or []
            if not infos:
                print("  ⚠️  未返回任何币种余额信息\n")
                continue
            for info in infos:
                currency = info.get("currency", "?")
                symbol = "¥" if currency == "CNY" else "$" if currency == "USD" else ""
                print(f"  余额 {symbol}{info.get('total_balance', '?')} {currency}"
                      f"  (赠金 {info.get('granted_balance', '?')}"
                      f" / 充值 {info.get('topped_up_balance', '?')})")
            print(f"  可用: {'✅ 是' if data.get('is_available') else '❌ 否（调用会返回 402）'}\n")

    if args.threshold is not None:
        for item in results:
            if not item["ok"]:
                continue
            if lowest_balance(item["data"].get("balance_infos") or []) < args.threshold:
                print(f"⚠️  {item['source']} 余额低于阈值 {args.threshold}", file=sys.stderr)
                return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
