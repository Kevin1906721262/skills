#!/usr/bin/env bash
# 把 SRT 烧成硬字幕
# 用法: burn.sh <视频路径> <字幕srt> [输出路径]
set -euo pipefail

# ⚠️ 必须是带 libass 的构建。Homebrew 版 ffmpeg 没有 libass，用了会报 "No such filter"
FFMPEG="${FFMPEG_FULL:-$HOME/.local/bin/ffmpeg-full}"

FONT="${SUB_FONT:-PingFang SC}"
SIZE="${SUB_SIZE:-15}"          # libass PlayResY=288，实际像素 = SIZE × (视频高/288)
OUTLINE="${SUB_OUTLINE:-0.8}"   # ⚠️ 中文超过 ~1 就会糊成一团黑
MARGINV="${SUB_MARGINV:-25}"
CRF="${SUB_CRF:-19}"
PRESET="${SUB_PRESET:-medium}"

if [ $# -lt 2 ]; then
  echo "用法: $(basename "$0") <视频路径> <字幕srt> [输出路径]" >&2
  exit 2
fi

video="$1"; srt="$2"
[ -f "$video" ] || { echo "错误: 找不到视频 $video" >&2; exit 2; }
[ -f "$srt" ]   || { echo "错误: 找不到字幕 $srt" >&2; exit 2; }

base="$(basename "$video")"; base="${base%.*}"
out="${3:-$(dirname "$video")/${base}-字幕版.mp4}"

# 前置检查: 滤镜是否存在
# 注意: 这里不能用 `ffmpeg -filters | grep -q`。grep -q 一命中就关管道，ffmpeg 吃 SIGPIPE
# 返回非零，配合 set -o pipefail 会让整条管道判为失败 —— 滤镜明明存在也会误报"缺 libass"。
# 先整体读进变量再匹配，避免子进程被提前关闭。
[ -x "$FFMPEG" ] || { echo "错误: 找不到 $FFMPEG" >&2; exit 3; }
filters="$("$FFMPEG" -hide_banner -filters 2>/dev/null || true)"
if [ "${filters#* subtitles }" = "$filters" ]; then
  echo "错误: $FFMPEG 不含 subtitles 滤镜 (缺 libass)" >&2
  echo "      换用带 libass 的构建，或从 https://ffmpeg.martin-riedl.de 下 macos/arm64 静态构建" >&2
  exit 3
fi

# 转义字幕路径中的 filtergraph 特殊字符
esc_srt="$(printf '%s' "$srt" | sed -e 's/\\/\\\\/g' -e "s/'/\\\\'/g" -e 's/:/\\:/g')"
style="FontName=${FONT},FontSize=${SIZE},PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=${OUTLINE},Shadow=0,MarginV=${MARGINV}"

# libass 把 SRT 按 PlayResY=288 解析，再放大到视频高度，所以描边要按高度换算才知实际粗细
height="$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$video" 2>/dev/null | head -1)"
scale="$(awk -v h="${height:-0}" 'BEGIN{ if (h>0) printf "%.2f", h/288; else print "?" }')"

echo "▶ 压制中 …"
echo "   字体=${FONT} 字号=${SIZE} 描边=${OUTLINE} (视频高 ${height:-?} → 实际描边≈$(awk -v o="$OUTLINE" -v s="$scale" 'BEGIN{ if (s=="?") print "?"; else printf "%.1f", o*s }')px)"
"$FFMPEG" -y -nostdin -i "$video" \
  -vf "subtitles='${esc_srt}':force_style='${style}'" \
  -c:v libx264 -preset "$PRESET" -crf "$CRF" -pix_fmt yuv420p \
  -c:a copy -movflags +faststart \
  "$out"

echo
echo "✅ 完成: $out"
ls -lh "$out"
