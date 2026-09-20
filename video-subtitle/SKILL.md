---
name: video-subtitle
description: 给视频配字幕——转写语音成文稿/SRT，校对后烧成硬字幕。当用户说"给视频配字幕/加字幕/烧字幕/压字幕/视频转文字/把文字配进去/提取视频文案"时使用。
argument-hint: "<视频路径> [--soft] [--lang zh]"
---

# video-subtitle — 视频配字幕

四步流水线：**抽音轨 → 转写 → 自动校对 → 烧录**。前三步由 `transcribe.sh` 一气呵成，你只需在转写后补一遍词典漏掉的错字。

产物（**校对后的 SRT 必须**、`.txt`/`.raw.*` 顺带）一律落在**视频同目录**，不要只丢在 `/tmp`。SRT 是可复用资产：用户回头说"字号调大点""这句写错了"，直接改它重烧即可，**不必重新转写** —— 转写才是全流程最慢的一步。

> **全程无人值守**：不向用户确认、不中途提问。所有判断题（错字修正、样式选型）自行按大概率落定，事后在交付说明里讲清改了什么。

## 环境依赖（本机已就绪）

| 组件 | 路径 | 用途 |
| --- | --- | --- |
| `whisper-cli` | `~/.local/bin/whisper-cli` | 语音转写 |
| 模型 large-v3-turbo | `~/.local/share/whisper.cpp/models/ggml-large-v3-turbo.bin` | 中文识别 |
| **`ffmpeg-full`** | `~/.local/bin/ffmpeg-full` | **烧字幕（带 libass）** |
| `ffmpeg` / `ffprobe` | `/opt/homebrew/bin/` | 抽音轨、探测、看片 |

> ⚠️ **最关键的坑：Homebrew 的 `ffmpeg` 没编译 libass**，`subtitles`/`ass`/`drawtext` 滤镜全不存在，直接拿它烧字幕会报 `No such filter`。烧字幕**只能用 `ffmpeg-full`**。找不到 libass 版就从 https://ffmpeg.martin-riedl.de 下 `macos/arm64` 静态构建丢到 `~/.local/bin/ffmpeg-full`。

## 步骤

### 1-2. 抽音轨 + 转写

```bash
bash ~/.agents/skills/video-subtitle/scripts/transcribe.sh <视频> [输出目录]
```

产出 `<名字>.wav` / `.txt` / `.srt`（默认落在视频同目录）。脚本内部先抽 16kHz 单声道 WAV —— whisper 只吃这个规格，直接喂视频会失败或极慢。

`LANG_CODE=auto` 可自动识别，但**中文长音频不要用 auto**：容易在中间段落切到英文，导致后半段全错。中文一律 `LANG_CODE=zh`。

### 3. 校对 ASR（自动，不问人）

whisper 中文的错误**不是随机噪声，是稳定的同音字替换**，且高频词会反复错。所以这步不靠人盯，靠两层：

**第一层 —— 词典自动替换**（`transcribe.sh` 已自动执行）

`asr-fixes.tsv` 收录已知错字，命中即换，映射唯一、无需判断。跑完会打印改了哪些、各改了几处。

单独对已有文件跑（如手改过字幕想再洗一遍）：

```bash
python3 ~/.agents/skills/video-subtitle/scripts/fix-asr.py out.srt          # 原地修正
python3 ~/.agents/skills/video-subtitle/scripts/fix-asr.py --dry-run out.srt # 只看不改
```

**第二层 —— 你通读一遍，补词典没覆盖的**。重点看这几类：

- **专有名词**：产品名、人名、缩写（DeepSeek、Ctrl+E、token）错得最隐蔽，也最伤可信度
- **自相矛盾的短语**："把面板换出来"读着别扭，即是"唤出来"之误
- **长句里的低频词**：词典不可能穷举，新视频必有新错字

> ⚠️ **不要向用户确认，也不要停下来问。** 直接采用概率最高的写法落地；实在无法判断的，任选一个即可。硬字幕烧完就改不了了，但"停下来等确认"比"选错一个字"代价更大。

**口语自我修正要保留原样**：如"谢谢大家 / 也不是谢谢大家 / 谢谢观看"，那是真人说话，不是识别错误，别"修"它。

**把新发现的错字追加进 `asr-fixes.tsv`** —— 词典是复利资产，下次同类视频直接自动过掉：

```
错误的写法	正确写法	备注
```

### 4. 烧录硬字幕

```bash
bash ~/.agents/skills/video-subtitle/scripts/burn.sh <视频> <校对后.srt> [输出路径]
```

默认输出 `<视频名>-字幕版.mp4`，与原片同目录（**不覆盖原片**）。

### 可选：只要软字幕 / 只要文稿

- 只要文稿：到第 3 步为止，`.txt` 即交付物
- 软字幕（可关、不重编码，但微信/飞书预览不一定显示）：`ffmpeg -i v.mov -i s.srt -c copy -c:s mov_text out.mp4`

## 样式调参

脚本可用环境变量覆盖：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SUB_FONT` | `PingFang SC` | 中文字体（系统自带 PingFang / Hiragino Sans GB / STHeiti 均可） |
| `SUB_SIZE` | `15` | 见下方换算 |
| `SUB_OUTLINE` | `0.8` | **中文别超过 1** |
| `SUB_MARGINV` | `25` | 距底边距 |
| `SUB_CRF` | `19` | 画质，屏幕录制类 18~20 足够 |
| `SUB_PRESET` | `medium` | 想快改 `veryfast` |

**字号/描边的换算（重要）**：libass 把无样式的 SRT 按 `PlayResY=288` 解析，再整体放大到视频高度。所以 1584p 视频的放大倍率是 1584/288 ≈ **5.5×**：

- `FontSize=15` → 实际约 **82px**
- `Outline=0.8` → 实际约 **4.4px**
- ⚠️ **中文描边必须 ≤1**：汉字笔画密集，描边一粗，相邻笔画的黑边就连成一片实心黑块，整行糊掉。这是中文和拉丁文最大的差异，英文食谱里的 `Outline=2~3` 放中文上必翻车。

改样式前先只渲一帧看效果，别直接跑整片：

```bash
ffmpeg-full -v error -y -ss 5 -i in.mov \
  -vf "subtitles='x.srt':force_style='...',scale=1600:-1" \
  -frames:v 1 -update 1 /tmp/style.png
```

> ⚠️ `-ss` 放在 `-i` **之前**会让时间戳归零，字幕滤镜会显示第 1 条而非该时刻的条目。**预览样式没问题，但别用它验证时间轴同步。**

## 验收（交付前自查）

1. **流完整性**：`ffprobe -v error -show_entries format=duration -show_entries stream=codec_type,codec_name,width,height -of default=noprint_wrappers=1 out.mp4` —— 时长要与源一致，视频+音频轨都在
2. **字幕真的烧进去了**：抽一帧看，别只看有没有报错
   ```bash
   ffmpeg-full -v error -y -ss <某条字幕的时刻> -i out.mp4 -frames:v 1 -update 1 /tmp/check.png
   ```
3. **时间轴对得上**：挑 2-3 个抽帧点，确认画面上出现的字幕 = SRT 里该时刻的条目
4. **体积合理**：屏幕录制（画面基本静止）crf19 出来会比源片小很多，通常 400~600kbps —— **这是正常的**，不代表画质丢了。存疑就抽同一帧与源片对比

## 输出约定

- 硬字幕版命名 `<原片名>-字幕版.mp4`，与原片并列，**永不覆盖原片**
- **校对后的 `.srt` 必须单独放一份到视频同目录**（与视频并列，不是只躺在 `/tmp`）—— 它是可复用资产：调样式、改个别错字、换字号，全靠它。丢了就得重新转写一遍
- `.wav` / `.txt`（原始稿 `.raw.*`）也留在同目录备查
- 交付时说明：分辨率、时长、体积，以及**你改了哪些 ASR 错字**（用户需要知道改动范围）

## 重复诉求：先看 SRT 在不在，别急着重转

只要视频同目录已有 `<原片名>.srt`，下列诉求**一律跳过 1-3 步，直接从改 SRT 开始**：

| 诉求 | 做法 |
| --- | --- |
| 调字幕样式 / 字号 / 位置 | 改 `burn.sh` 的环境变量，重跑第 4 步 |
| 某句字幕写错了 | 直接改 `.srt` 对应行，重跑第 4 步 |
| 改成软字幕 / 只要文稿 | 复用已有 SRT，不必重转 |
| 给另一个视频配字幕 | 才走完整流程 |

> 转写是整条流水线最慢的一步，重烧只要几分钟。**动手前先 `ls` 视频同目录确认 SRT 在不在**，在就直接用。
> 带 `-ss` 抽帧验证时记得 `-ss` 放 `-i` **之后**，否则时间戳归零、字幕滤镜只显示第 1 条（见上文）。

## 相关

- 语音转写的底层环境见记忆 `local-whisper-cpp-setup`
- ffmpeg 缺 libass 的完整背景见记忆 `homebrew-ffmpeg-lacks-libass`
