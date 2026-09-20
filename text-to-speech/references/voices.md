# 音色与参数速查

全量音色 300+ 条，用 `tts.py --list-voices | grep '^zh-CN'` 现查最准。下面是常用精选。

## 中文常用音色

| 音色 | 性别 | 气质 / 适用 |
| --- | --- | --- |
| `zh-CN-XiaoxiaoNeural` | 女 | 温暖自然，通用默认；教程、口播 |
| `zh-CN-XiaoyiNeural` | 女 | 活泼、偏卡通/小说 |
| `zh-CN-YunxiNeural` | 男 | 标准普通话，年轻，叙述感强 |
| `zh-CN-YunyangNeural` | 男 | 专业新闻播报味 |
| `zh-CN-YunjianNeural` | 男 | 激情解说、体育 |
| `zh-CN-liaoning-XiaobeiNeural` | 女 | 东北口音 |
| `zh-CN-shaanxi-XiaoniNeural` | 女 | 陕西口音 |
| `zh-HK-HiuGaaiNeural` / `zh-TW-HsiaoChenNeural` | 女 | 粤语 / 台湾国语 |

## 常用外语

| 音色 | 说明 |
| --- | --- |
| `en-US-AriaNeural` | 英文女声，新闻/小说，正向自信 |
| `en-US-GuyNeural` | 英文男声，有情绪张力 |
| `en-US-EmmaMultilingualNeural` | 多语言女声，中英混读时切换更自然 |
| `en-US-AndrewMultilingualNeural` | 多语言男声 |
| `ja-JP-NanamiNeural` / `ja-JP-KeitaNeural` | 日语女 / 男 |
| `ko-KR-SunHiNeural` | 韩语女声 |

- 中英混排文本（技术文章常见）优先试 `*-MultilingualNeural`，读英文术语更像英文，不像逐字母拼读。
- 品牌名 / 缩写（edge-tts、gTTS、API、SRT）在中文音色下可能被逐字母念，必要时把文本改写成中文读法（“接口”“字幕文件”）再合成。

## 参数

```bash
--rate   -10%   # 语速，默认 +0%，口播常用 -5% ~ -15% 更从容
--volume -20%   # 音量
--pitch  -30Hz  # 音调，压低更像纪录片旁白
```

- 参数要带符号：`-10%`、`+20%`、`-30Hz`。
- 命令行里 `--rate=-10%` 写成等号形式，避免 `-10%` 被当成选项。

## 音色挑选流程

1. 中文口播默认 `zh-CN-XiaoxiaoNeural`；要男声用 `zh-CN-YunxiNeural`。
2. 同一段文本合成 2–3 个候选音色，让用户听后再定，比描述音色更有效。
3. 交付前用 `afplay` 或让用户在对话里直接播放确认。
