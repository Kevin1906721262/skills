---
name: chatcut-hosted-import-export
description: 在 Codex 里用 ChatCut 插件传素材、导入视频、导出成片时必读。触发场景：「帮我把这个视频传到 ChatCut」「把素材导入项目」「上传怎么这么久/一直卡住」「registered asset was not found for upload」「video asset was not found for transcription」「asset was not found」导入失败、素材传上去后分辨率变了、导出成片、导出的视频音量太小、降噪/人声分离之后人声变小了、fit cover 裁切对不对、downloadUrl 下载、preview_timeline 没有图。覆盖：长视频先剪再传、导入会话过期与 retry 提示陷阱、上传后转码收敛到 1920 宽、降噪后必须实测响度再补增益、导出验收（volumedetect + 抽帧）、文件大小不能当判据、viewer 没图时的替代验证。
---

# ChatCut 素材导入 / 导出避坑

适用：ChatCut 插件（hosted `chatcut` MCP）在 Codex 里做媒体导入与成片导出时。只讲这次真踩过的坑，不重复插件自带 skill 的操作步骤。

## 0. 两条总原则

- 媒体导入助手（`upload-media.mjs`）是唯一合法通道，但它慢，而且**导入会话会过期**。
- 一切结论以实测为准：分辨率查**转码后**的真实值，响度查**导出成片**，不要用参数反推。

## 1. 长视频不要整条传 —— 先本地剪出需要的那一段

现象：392 秒 / 2736×1584 / 60fps 的录屏，助手先本地硬件 H.264 转码，产出约 99MB 再分片上传，前后 3~5 分钟。
同样的助手传一条本地剪好的 30 秒片段，40 秒内完成。

只要其中一段就先剪出来再传：

```bash
ffmpeg -y -ss 140 -i in.mp4 -t 30 \
  -c:v libx264 -preset slow -crf 17 -pix_fmt yuv420p \
  -c:a aac -b:a 192k -movflags +faststart \
  -colorspace bt709 -color-primaries bt709 -color-trc bt709 out.mp4
```

- `-ss` 放在 `-i` 前更快；需要精确到帧再放后面。
- **别指望 `-c copy` 卡关键帧**：这条素材 135~175 秒之间一个关键帧都没有，流复制会多出好几秒。要精确时长就重编码（源码率低，CRF 17 重编一次几乎无损）。
- 选切点用停顿检测，别切在半句话上：

```bash
ffmpeg -hide_banner -nostats -ss 95 -t 115 -i in.mp4 \
  -af "silencedetect=n=-32dB:d=0.30" -f null - 2>&1 | grep -E "silence_(start|end)"
```

例外：如果这段素材之后要在 ChatCut 里做真正的剪辑（多段挑选、重排结构、从原素材切 B-roll），按 ChatCut 规范应传原始素材；"我就要这一段"时才先剪。

## 2. 导入失败：两种 400 与它们的正确处置

**报错一**：`Token endpoint returned HTTP 400. {"statusCode":400,"message":"registered asset was not found for upload"}`
出现在字节传完、准备 finalize 时。根因：导入会话过期（`ttlSeconds` 默认 1800）或这一轮被打断。

**报错二**：`{"statusCode":400,"message":"video asset was not found for transcription"}`
出现在照提示带 `--asset-id` 续传时。根因：那个占位资产已经不存在了。

处置：

- 助手返回的 `retry.args`（带 `--asset-id`）**只在占位资产还活着时有效**。如果上一次会话已过期很久，或项目里查不到这个资产，别照抄：直接 `import_media action=create_session` 开新会话、**去掉 `--asset-id`** 重新完整导入。
- 排错第一步永远是 `browse_assets` 看项目里到底有没有这个资产，而不是重试。
- 长导入要放在一个不会被中断的回合里跑完；中途被打断基本等于白传。

## 3. 上传后分辨率会被收敛到 1920 宽

现象：2736×1584 传上去，项目里的素材是 **1920×1112**（助手 metadata 里 `transcodeReason: "video dimensions 2736x1584 exceed 1920px"`）。

画布怎么摆取决于**这个数字**，不是原片：

- 1920×1112 放进 1920×1080 画布用 `fit:"cover"` 只裁上下各 1.4%（约 16px）——先抽帧确认没切到字幕/UI 再放心用。
- 拿不准就用 `fit:"contain"`，代价是左右各约 27px 黑边。
- 不想裁也不想留边：用 `manage_timelines action=update` 把画布改成素材比例。画幅是 **per-timeline** 状态，不是项目设置。
- 放置后若返回 `visualReviewRequired`，它要的是"源帧 vs 合成帧"对比，别跳过：`inspect_asset` 取源帧 → `preview_timeline views:["viewer"]` 取合成帧 → 比对 → 确认字幕/文字/UI 边缘没被切掉。

## 4. 降噪之后必须重新测响度（血亏一次）

事件：做完 AI 人声降噪后按预估给了 `+4dB`，导出实测 **mean −29.0dB / max −11.0dB**，比原始素材（−27.4 / −6.7）**还轻**。改成 `+11dB` 才得到 mean −22.0 / max −4.0 的正常响度。

根因：语音隔离/降噪在压掉底噪的同时会把整体电平一起拉下去（这次净损失约 7~8dB 峰值）。

正确顺序：

1. 先做降噪（`isolate_voice`；编辑器开着时走前端路由最快，返回里 `route:"frontend"`）。
2. **导出一次成型文件**。
3. 下载后实测：`ffmpeg -i out.mp4 -af volumedetect -f null - 2>&1 | grep -E "mean_volume|max_volume"`。
4. 按实测差距反推增益（`edit_item updates` 里的 `decibelAdjustment`，单位就是 dB，`0` = 不变），再导出一次。

目标：峰值留 3~4dB 余量（例如峰值 −4dB），别贴 0。
**不要在降噪前就把增益一起算进去**——两者不可叠加估算。

## 5. 导出验收清单（文件大小不能当判据）

事件：改完增益重新导出，两版**字节数一模一样**（7,022,257 bytes），一度以为没生效；实际一版 −29/−11、一版 −22/−4。AAC 固定码率，音轨改了大小不变。

验收缺一不可：

- `ffprobe` 查时长/分辨率/帧率/声道，确认与预期一致。
- `ffmpeg -v error -i out.mp4 -f null -` 跑一遍确认无解码错误（顺带 `echo "decode OK"`）。
- `volumedetect` 查响度。
- **抽帧看图**：首帧（淡入中）、中间稳定帧、末帧（淡出中）各一张，做成长图或拼图看一遍，确认淡入淡出、字幕完整性、裁切没切到关键内容。
- 交付：把 `downloadUrl` 的成片下载到 `~/Downloads/`，用绝对路径在聊天里展示（`![名字](/Users/.../x.mp4)`）。

## 6. `preview_timeline` 的 viewer 不保证给图

现象：同一类调用，第一次每个采样帧都带 jpeg `uri`，第二次只有 `frame` / `timelineTimeMs`、没有 `uri`。

对策：不要把它当唯一验证手段。结构用 `views:["timeline"]` 核对（轨道、起止帧、gap、role），画面用**导出成片抽帧**验证——那比云端预览更接近交付物。
