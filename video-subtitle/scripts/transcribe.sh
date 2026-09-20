#!/usr/bin/env bash
# 视频 → 音频 → 文字稿 + SRT（自动过一遍同音字修正词典）
# 用法: transcribe.sh <视频路径> [输出目录]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WHISPER="${WHISPER_BIN:-$HOME/.local/bin/whisper-cli}"
MODEL="${WHISPER_MODEL:-$HOME/.local/share/whisper.cpp/models/ggml-large-v3-turbo.bin}"
FFMPEG="${FFMPEG_BIN:-ffmpeg}"
LANG_CODE="${LANG_CODE:-zh}"
FIXER="$SCRIPT_DIR/fix-asr.py"

if [ $# -lt 1 ]; then
  echo "用法: $(basename "$0") <视频路径> [输出目录]" >&2
  exit 2
fi

video="$1"
[ -f "$video" ] || { echo "错误: 找不到文件 $video" >&2; exit 2; }

[ -x "$WHISPER" ] || { echo "错误: 找不到 whisper-cli ($WHISPER)" >&2; exit 3; }
[ -f "$MODEL" ] || { echo "错误: 找不到模型 ($MODEL)" >&2; exit 3; }

base="$(basename "$video")"; base="${base%.*}"
outdir="${2:-$(dirname "$video")}"
mkdir -p "$outdir"

wav="$outdir/$base.wav"

echo "▶ 抽取音轨 (16kHz 单声道) …"
"$FFMPEG" -v error -y -i "$video" -vn -ac 1 -ar 16000 -c:a pcm_s16le "$wav"

echo "▶ 转写中 (语言=$LANG_CODE, 模型=$(basename "$MODEL")) …"
# 注意: -l 必须显式指定，auto 在中文长音频上容易在中途切到英文
# 输出到 .raw.* —— 原始稿保留下来，方便回溯改了什么
"$WHISPER" -m "$MODEL" -f "$wav" -l "$LANG_CODE" -otxt -osrt -of "$outdir/$base.raw" 2>&1 \
  | grep -iE "error|failed" || true

[ -f "$outdir/$base.raw.srt" ] || { echo "错误: 转写未产出 SRT" >&2; exit 4; }

# 修正稿 = 原始稿的副本，交给词典处理
cp "$outdir/$base.raw.txt" "$outdir/$base.txt"
cp "$outdir/$base.raw.srt" "$outdir/$base.srt"

echo
echo "▶ 自动修正同音字 (词典: asr-fixes.tsv) …"
python3 "$FIXER" "$outdir/$base.txt" "$outdir/$base.srt"

# 指定了别的输出目录时，也把校对后的 SRT 放一份到视频旁 ——
# 它是可复用资产（调样式/改错字都靠它），缺了就得重转写。视频同目录才是它该待的地方。
videodir="$(dirname "$video")"
if [ "$outdir" != "$videodir" ]; then
  cp "$outdir/$base.srt" "$videodir/$base.srt"
  cp "$outdir/$base.txt" "$videodir/$base.txt"
  echo "↩ 已回存一份到视频同目录: $videodir/$base.srt"
fi

echo
echo "✅ 完成"
echo "   文稿:    $outdir/$base.txt"
echo "   字幕:    $outdir/$base.srt   ← 拿去烧录用这个（留在视频旁，别删）"
echo "   原始稿:  $outdir/$base.raw.txt / .raw.srt"
echo
echo "ℹ️  后续「调样式 / 改个别错字」直接改 .srt 重烧，不要重新转写（转写最慢）"
echo
echo "⚠️  词典只覆盖已知错字。你仍须通读 $base.txt，修正词典未收录的错字"
echo "    （专名、生僻技术词最易漏），并把新发现的错误追加进 asr-fixes.tsv"
