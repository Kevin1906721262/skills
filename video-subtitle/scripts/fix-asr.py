#!/usr/bin/env python3
"""按词典自动修正 ASR 同音字错误。

设计前提：**不需要人工确认**。词典里的条目都是高置信度的一对一映射，
命中即替换；无法判断时按词典给定的写法落地，不中断流程去问人。

用法:
    fix-asr.py <文件> [文件...]      # 原地修正
    fix-asr.py --dry-run <文件>      # 只报告，不落盘
"""
import os
import sys

SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_rules(path):
    rules = []
    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.rstrip("\n")
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) < 2:
                continue
            pat, rep = parts[0].strip(), parts[1].strip()
            if pat and rep and pat != rep:
                rules.append((pat, rep))
    # 长模式优先，避免短模式先吃掉长模式的一部分
    rules.sort(key=lambda r: -len(r[0]))
    return rules


def fix_file(path, rules, dry_run=False):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    hits = []
    total = 0
    for pat, rep in rules:
        n = text.count(pat)
        if n:
            text = text.replace(pat, rep)
            hits.append((pat, rep, n))
            total += n
    if hits and not dry_run:
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
    return hits, total


def main():
    args = [a for a in sys.argv[1:]]
    dry_run = "--dry-run" in args
    args = [a for a in args if a != "--dry-run"]

    if not args:
        print(__doc__, file=sys.stderr)
        return 2

    dict_path = os.environ.get("ASR_DICT", os.path.join(SKILL_DIR, "asr-fixes.tsv"))
    if not os.path.isfile(dict_path):
        print(f"错误: 找不到词典 {dict_path}", file=sys.stderr)
        return 3

    rules = load_rules(dict_path)
    grand = 0
    for path in args:
        if not os.path.isfile(path):
            print(f"跳过(不存在): {path}", file=sys.stderr)
            continue
        hits, total = fix_file(path, rules, dry_run)
        grand += total
        tag = "(dry-run)" if dry_run else "已修正"
        if hits:
            print(f"{tag} {os.path.basename(path)} — {total} 处")
            for pat, rep, n in sorted(hits, key=lambda h: -h[2]):
                print(f"    {pat} → {rep}  ×{n}")
        else:
            print(f"{tag} {os.path.basename(path)} — 无需修正")
    return 0 if grand >= 0 else 1


if __name__ == "__main__":
    sys.exit(main())
