#!/usr/bin/env python3
"""文字转语音：edge-tts（默认）或 gTTS（兜底），可选字幕（整句 / 逐词对齐）。

用法示例：
  tts.py --text "你好，世界" --out-prefix demo/say
  tts.py --file article.md --subs word --voice zh-CN-YunxiNeural --rate=-10%
  tts.py --list-voices --locale zh

设计要点（都是实测踩过的坑）：
  1. edge-tts 单次请求的音频会被硬截断在 600 秒，但字幕仍按全文本输出 →
     长文本必须分块合成、拼接、再整体偏移字幕时间轴（本脚本自动处理）。
  2. CLI 的 --write-subtitles 只给整句级字幕，逐词对齐要 python API 的
     boundary="WordBoundary"。
"""

from __future__ import annotations

import argparse
import asyncio
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

CHUNK_LIMIT = 1200  # 每块字符数上限（约 3 分钟语音，远低于 600 秒截断线）
END_PUNCT = "。！？!?；;"
SOFT_PUNCT = "，、：:—…"
WORD_GROUP_MAX = 16  # 逐词字幕单条最长字符数


# ---------------------------------------------------------------- 文本准备

def strip_markdown(text: str) -> str:
    """把 Markdown 正文清成适合朗读的纯文本。"""
    text = re.sub(r"```.*?```", " ", text, flags=re.S)          # 代码块
    text = re.sub(r"^\s*(#{1,6})\s*", "", text, flags=re.M)      # 标题井号
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", text)            # 图片
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)         # 链接保留文字
    text = re.sub(r"https?://\S+", " ", text)                    # 裸 URL 念出来没意义
    text = re.sub(r"^\s*\|.*\|\s*$", " ", text, flags=re.M)      # 表格行
    text = re.sub(r"^\s*[-*+]\s+", "", text, flags=re.M)         # 列表符号
    text = re.sub(r"[*_`]{1,3}", "", text)                       # 强调 / 行内代码
    text = re.sub(r"^\s*>\s?", "", text, flags=re.M)             # 引用
    text = re.sub(r"^\s*-{3,}\s*$", " ", text, flags=re.M)       # 分隔线
    return text


def _units(text: str, limit: int):
    """按段落 → 句子产出朗读单元，超长句再按软标点硬切。"""
    for para in re.split(r"\n\s*\n", text):
        para = " ".join(para.split())
        if not para:
            continue
        sentences = re.split(r"(?<=[。！？!?；;])|(?<=[.!?])\s+", para)
        for sent in sentences:
            sent = sent.strip()
            while len(sent) > limit:
                cut = max(sent.rfind(p, 0, limit) for p in SOFT_PUNCT)
                cut = cut + 1 if cut > limit // 2 else limit
                yield sent[:cut]
                sent = sent[cut:].lstrip()
            if sent:
                yield sent


def split_chunks(text: str, limit: int = CHUNK_LIMIT) -> list[str]:
    """把朗读单元贪心装箱，保证每块不超过 limit 字符。"""
    chunks: list[str] = []
    cur = ""
    for unit in _units(text, limit):
        if cur and len(cur) + len(unit) > limit:
            chunks.append(cur)
            cur = ""
        cur += unit if not cur else " " + unit if unit[:1].isascii() else unit
    if cur:
        chunks.append(cur)
    return chunks or [text.strip()]


# ---------------------------------------------------------------- 合成

def synth_edge(text: str, voice: str, out_mp3: Path, *, rate: str, volume: str,
               pitch: str, boundary: str) -> list[tuple[str, int, int]]:
    """合成一块并写 mp3，返回 boundary 事件 [(文本, 起点ms, 终点ms)]。"""
    import edge_tts

    async def run() -> list[tuple[str, int, int]]:
        comm = edge_tts.Communicate(
            text, voice, rate=rate, volume=volume, pitch=pitch, boundary=boundary
        )
        events: list[tuple[str, int, int]] = []
        with open(out_mp3, "wb") as fh:
            async for chunk in comm.stream():
                if chunk["type"] == "audio":
                    fh.write(chunk["data"])
                elif chunk["type"] in ("WordBoundary", "SentenceBoundary"):
                    start = chunk["offset"] // 10_000
                    end = (chunk["offset"] + chunk["duration"]) // 10_000
                    events.append((chunk["text"], start, end))
        return events

    return asyncio.run(run())


def synth_gtts(text: str, out_mp3: Path, *, lang: str) -> None:
    from gtts import gTTS

    gTTS(text, lang=lang).save(str(out_mp3))


# ---------------------------------------------------------------- 字幕

def fmt_ts(ms: int) -> str:
    h, ms = divmod(ms, 3600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def group_word_events(events: list[tuple[str, int, int]]) -> list[list[tuple[str, int, int]]]:
    """把逐词事件按标点/长度合成字幕条。"""
    groups: list[list[tuple[str, int, int]]] = []
    cur: list[tuple[str, int, int]] = []
    for ev in events:
        cur.append(ev)
        joined = "".join(w[0] for w in cur)
        if ev[0] in END_PUNCT or (
            ev[0] in SOFT_PUNCT and len(joined) >= WORD_GROUP_MAX // 2
        ) or len(joined) >= WORD_GROUP_MAX:
            groups.append(cur)
            cur = []
    if cur:
        groups.append(cur)
    return groups


def write_srt(path: Path, entries: list[tuple[int, int, str]]) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        for i, (start, end, text) in enumerate(entries, 1):
            fh.write(f"{i}\n{fmt_ts(start)} --> {fmt_ts(end)}\n{text}\n\n")


# ---------------------------------------------------------------- 音频工具

def probe_duration_ms(path: Path) -> int | None:
    if not shutil.which("ffprobe"):
        return None
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(path)],
        capture_output=True, text=True,
    )
    try:
        return int(float(out.stdout.strip()) * 1000)
    except ValueError:
        return None


def concat_mp3(parts: list[Path], out_mp3: Path) -> str:
    """拼接 mp3，返回所用方式（concat-demuxer / raw-bytes）。"""
    if shutil.which("ffmpeg"):
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False,
                                         encoding="utf-8") as fh:
            for part in parts:
                fh.write(f"file '{part.resolve()}'\n")
            listfile = Path(fh.name)
        cmd = ["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0",
               "-i", str(listfile), "-c", "copy", str(out_mp3)]
        if subprocess.run(cmd).returncode == 0 and out_mp3.exists():
            listfile.unlink(missing_ok=True)
            return "concat-demuxer"
        listfile.unlink(missing_ok=True)
    with open(out_mp3, "wb") as dst:  # 兜底：裸字节拼接，多数播放器能吃
        for part in parts:
            dst.write(part.read_bytes())
    return "raw-bytes"


def convert(src: Path, fmt: str) -> Path:
    if not shutil.which("ffmpeg"):
        print(f"⚠️  未找到 ffmpeg，保留 mp3 不转 {fmt}")
        return src
    dst = src.with_suffix(f".{fmt}")
    codec = {"wav": "pcm_s16le", "m4a": "aac", "mp3": "copy"}.get(fmt, "copy")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src),
                    "-c:a", codec, str(dst)], check=True)
    src.unlink(missing_ok=True)  # 转格式后不留中间 mp3
    return dst


# ---------------------------------------------------------------- 主流程

def list_voices(locale: str | None) -> None:
    out = subprocess.run([sys.executable, "-m", "edge_tts", "--list-voices"],
                         capture_output=True, text=True)
    for line in out.stdout.splitlines():
        if locale and not line.startswith(locale):
            continue
        print(line)


def main() -> int:
    ap = argparse.ArgumentParser(description="文字转语音（edge-tts / gTTS）")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--text", help="直接给文本")
    src.add_argument("--file", help="从文件读文本（.md 会自动清掉 Markdown 标记）")
    src.add_argument("--list-voices", action="store_true", help="列出可用音色")
    ap.add_argument("--voice", default="zh-CN-XiaoxiaoNeural", help="音色名")
    ap.add_argument("--rate", default="+0%", help="语速，如 -10%% 或 +20%%")
    ap.add_argument("--volume", default="+0%", help="音量，如 -20%%")
    ap.add_argument("--pitch", default="+0Hz", help="音调，如 -30Hz")
    ap.add_argument("--engine", default="edge", choices=["edge", "gtts"])
    ap.add_argument("--lang", default="zh-CN", help="gTTS 语言代码")
    ap.add_argument("--subs", default="none", choices=["none", "sentence", "word"],
                    help="字幕级别：none / sentence（整句）/ word（逐词对齐）")
    ap.add_argument("--out", help="输出前缀，产出 <前缀>.mp3 / .srt")
    ap.add_argument("--out-dir", default=".", help="未给 --out 时的输出目录")
    ap.add_argument("--format", default="mp3", choices=["mp3", "wav", "m4a"],
                    help="输出格式（非 mp3 需 ffmpeg）")
    ap.add_argument("--raw", action="store_true", help="不做 Markdown 清理")
    ap.add_argument("--play", action="store_true", help="生成后用 afplay 播放")
    args = ap.parse_args()

    if args.list_voices:
        list_voices(None)
        return 0

    if args.text is not None:
        text = args.text
    else:
        path = Path(args.file)
        if not path.exists():
            print(f"❌ 找不到文件：{path}")
            return 2
        text = path.read_text(encoding="utf-8")
        if path.suffix.lower() in (".md", ".markdown") and not args.raw:
            text = strip_markdown(text)

    text = text.strip()
    if not text:
        print("❌ 文本为空")
        return 2

    out_base = Path(args.out) if args.out else (
        Path(args.out_dir) / f"tts-{re.sub(r'[^\w\u4e00-\u9fff]+', '-', text[:16]).strip('-')}"
    )
    out_base.parent.mkdir(parents=True, exist_ok=True)

    chunks = split_chunks(text)
    print(f"🔊 {len(text)} 字 → {len(chunks)} 块 | 音色 {args.voice} | 引擎 {args.engine}")

    boundary = "WordBoundary" if args.subs == "word" else "SentenceBoundary"
    subs: list[tuple[int, int, str]] = []
    offset = 0
    tmpdir = Path(tempfile.mkdtemp(prefix="tts-"))
    parts: list[Path] = []

    for i, chunk in enumerate(chunks, 1):
        part = tmpdir / f"part{i:03d}.mp3"
        try:
            if args.engine == "edge":
                events = synth_edge(chunk, args.voice, part, rate=args.rate,
                                    volume=args.volume, pitch=args.pitch,
                                    boundary=boundary)
            else:
                synth_gtts(chunk, part, lang=args.lang)
                events = []
        except Exception as exc:  # noqa: BLE001 - 直接把失败原因暴露给调用方
            print(f"❌ 第 {i}/{len(chunks)} 块合成失败：{type(exc).__name__}: {exc}")
            return 1
        parts.append(part)

        if args.subs != "none" and events:
            if args.subs == "word":
                for group in group_word_events(events):
                    subs.append((offset + group[0][1], offset + group[-1][2],
                                 "".join(w[0] for w in group)))
            else:
                for ev in events:
                    subs.append((offset + ev[1], offset + ev[2], ev[0]))

        # 分块时长以音频文件为准，避免字幕时间轴漂移
        real = probe_duration_ms(part)
        offset += real if real else (events[-1][2] if events else 0)

    audio = out_base.with_suffix(".mp3")
    if len(parts) > 1:
        print(f"🧩 拼接方式：{concat_mp3(parts, audio)}")
    else:
        shutil.move(parts[0], audio)
    shutil.rmtree(tmpdir, ignore_errors=True)

    if args.format != "mp3":
        audio = convert(audio, args.format)

    if subs:
        srt = out_base.with_suffix(".srt")
        write_srt(srt, subs)
        print(f"📝 字幕：{srt}（{len(subs)} 条）")

    total = probe_duration_ms(audio)
    if total:
        print(f"⏱️  时长：{total / 1000:.1f}s")
        if subs and total + 500 < subs[-1][1]:
            print(f"⚠️  音频比字幕终点短 {subs[-1][1] - total} ms —— 可能被服务端截断")
    print(f"✅ 音频：{audio.resolve()}")

    if args.play and shutil.which("afplay"):
        subprocess.run(["afplay", str(audio)])
    return 0


if __name__ == "__main__":
    sys.exit(main())
