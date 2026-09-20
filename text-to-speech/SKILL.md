---
name: text-to-speech
description: 把文字转成语音音频（mp3，可选逐词对齐 SRT 字幕），用免费的 edge-tts 微软神经网络音色，支持中文/外语音色挑选、语速音量音调调节、长文本自动分块。当用户说「把这段文字转语音」「读出来 / 念一下 / 生成配音 / 旁白」「做个 TTS」「文字转 mp3」「顺便出字幕」时使用。不用于把已有视频的语音转字幕或翻译（用 video-subtitle），也不用于 ChatCut 项目内的配音（用 chatcut:voice）。
metadata:
  short-description: 文字转语音（edge-tts，含逐词字幕）
---

# 文字转语音

用 `edge-tts`（微软 Edge 在线神经网络 TTS，免费、无需 API Key）把文字合成为 mp3，
需要时同时产出逐词对齐的 SRT。脚本已经把踩过的坑处理掉了：长文本分块、拼接、
字幕时间轴偏移、截断检测。

## 快速开始

```bash
SKILL_DIR=~/.agents/skills/text-to-speech
TTS_PY="$HOME/.venvs/edge-tts/bin/python"        # 依赖装在独立 venv 里

# venv 不存在或报 ModuleNotFoundError 时先跑一次（幂等）
bash "$SKILL_DIR/scripts/setup.sh"

# 最短路径：给文本，出 mp3
$TTS_PY "$SKILL_DIR/scripts/tts.py" --text "要朗读的文字" --out /tmp/demo/say

# 给文章，出 mp3 + 逐词字幕
$TTS_PY "$SKILL_DIR/scripts/tts.py" --file article.md --subs word \
    --voice zh-CN-YunxiNeural --rate=-10% --out /tmp/demo/article
```

脚本每次都会打印音频绝对路径、时长和字幕条数；`--play` 可生成后直接 `afplay` 试听。

## 必须知道的几个事实

1. **单次请求的音频会被硬截断在 600 秒**，但字幕仍按全文输出——于是字幕时间轴
   会超出音频、静默说谎（实测 3852 字文本：音频 600.0s，字幕却排到 873s）。
   所以长文本必须分块合成再拼接。`tts.py` 已自动按 1200 字/块切分并按真实音频
   时长偏移字幕；**不要**用 `edge-tts` CLI 直接喂长文。
2. **CLI 的 `--write-subtitles` 只产出整句级字幕**（默认 `SentenceBoundary`），
   整篇只有一条覆盖全句的记录，不是文章宣传的“逐字对齐”。逐词对齐必须走 python
   API 并显式传 `boundary="WordBoundary"`，`tts.py --subs word` 就是这条路径。
3. **别用系统 Python 装包**：本机是 Homebrew Python 3.14，全局 `pip install` 会
   失败，依赖统一放 `$HOME/.venvs/edge-tts`，用该 venv 的 python 调脚本。
4. **两个引擎都是非官方接口**（edge-tts 借用 Edge 浏览器入口，gTTS 借用 Google
   翻译），随时可能失效或限流。edge-tts 音质好、音色多、能出字幕，是默认选择；
   `--engine gtts` 只作兜底，音色单一、不支持字幕和语速调节。
5. **中英混排**：中文音色会把 `edge-tts`、`API`、`SRT` 这类词逐字母念出来。要么
   换成 `*-MultilingualNeural`，要么在文本里改写成中文读法再合成。
6. 输出格式默认 mp3；`--format wav|m4a` 需要 ffmpeg（本机已装，转完会删掉中间 mp3）。
7. 分块拼接处会多出约 0.15 秒停顿（实测一段 14.5 分钟音频只在 3 个拼接点出现
   148/151/160ms 间隙，块内间隙为 0）。听感接近自然换段，需要严丝合缝时再用
   ffmpeg 裁掉这段静音。

## 常用命令

```bash
# 列出/筛选音色（音色挑选见 references/voices.md）
$TTS_PY "$SKILL_DIR/scripts/tts.py" --list-voices | grep '^zh-CN'

# 调语速音量音调（参数要带符号，命令行用等号形式）
$TTS_PY "$SKILL_DIR/scripts/tts.py" --text "..." --rate=-15% --pitch=-30Hz --out /tmp/demo/slow

# Markdown 文章直接朗读：默认会清掉 # ** ` 表格 代码块和裸 URL，--raw 可关闭
$TTS_PY "$SKILL_DIR/scripts/tts.py" --file article.md --raw --out /tmp/demo/raw

# 多音色试听，让用户挑
for v in zh-CN-XiaoxiaoNeural zh-CN-YunxiNeural zh-CN-YunyangNeural; do
  $TTS_PY "$SKILL_DIR/scripts/tts.py" --text "$TXT" --voice "$v" --out "/tmp/demo/$v"
done
```

## 交付方式

- 产物是 mp3（本地文件），在回复里用绝对路径的 Markdown 图片语法内联播放：
  `![alt](/绝对/路径/xxx.mp3)`。
- 多音色交付时逐个列出音色和时长，让用户说一句就能定稿。
- 长文本（>1200 字）先告知会分块合成、耗时几十秒，再开始跑；不要静默等。
- 字幕默认不生成。用户要“字幕 / 时间轴 / SRT”时才加 `--subs`，并说明 `word`
  （逐词，适合剪视频）还是 `sentence`（整句，适合校对文本）更合适。

## 验收与排查

生成的音频至少要确认“时长正常、不是截断的”。脚本会打印时长，并在音频比字幕终点
短 0.5s 以上时给出截断警告。

| 现象 | 处理 |
| --- | --- |
| `ModuleNotFoundError: edge_tts` | 跑 `bash scripts/setup.sh`，并用 venv 的 python |
| 合成很慢 / 卡住 | 到微软服务的网络不稳，重试一次；仍失败换 `--engine gtts` |
| 音频只有 10 分钟 | 走了 CLI 或未分块，改用 `tts.py` |
| 字幕对不上口型 | 用 `--subs word`；确认没有手工改过 mp3 |
| 中文音色读英文术语怪 | 换 Multilingual 音色，或改写文本 |

## 相关但不该用本 skill 的场景

- 已有视频要转写、翻译、烧字幕：用 `video-subtitle`。
- ChatCut 项目内的配音 / 旁白 / 音效：用 `chatcut:voice`。
