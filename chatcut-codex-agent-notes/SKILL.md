---
name: chatcut-codex-agent-notes
description: 在 Codex 里驱动 ChatCut 插件做视频时（做封面/片头 MG 动画、加背景音乐并自动压低、套设计风格、让用户选视觉方向、把编辑器打开在内置浏览器或用户自己的 Chrome）必读。触发场景：「用 ChatCut 做个封面」「加个片头标题动画」「MG 动画」「配背景音乐」「说话的时候音乐小一点/自动压低」「套一下设计风格」「你自己决定就行」「在 Chrome 里打开 ChatCut」「用内置浏览器打开」；以及遇到 ChatCut 自带 skill 之间说法冲突、原生 widget 标签不渲染、中文标题字体不对、片头音乐被意外压低。覆盖：Codex host adapter 映射（ask_followup_questions 而非原生标签）、风格选择门禁与"你自己决定"豁免、Design Style 字体的 CJK 映射、ducking 的 anchor/follower 摆法、浏览器 handoff 的 locale 前缀与 boot token、createBrowserTab 超时≠失败。
---

# 在 Codex 里用 ChatCut 插件（和内置 agent 不一样的地方）

ChatCut 那套自带 skill 的正文是写给 ChatCut 内置 agent 的。在 Codex 插件环境下有几处不一样，照抄会踩坑。

## 1. skill 之间冲突时，以 host adapter 为准

例：`create-motion-graphics` 要求"输出 ChatCut 原生 `<widget><form-visual>` 选择器"；但 `widget-forms` 的 Codex 适配器明确写：原生 `<widget>` / `<choices/>` / `<visual-option>` 标签**只在 ChatCut 内嵌环境渲染**，在 Codex / Claude Code 插件里绝不能输出。

结论：**冲突一律走 host adapter**。

- Codex 下结构化提问 / 视觉选择卡片 = MCP 工具 `ask_followup_questions`（支持 `variant:"visual"` 卡片、`preview` 缩略图、`onSubmit` 绑定 `manage_design_style apply_preset`）。一张表单最多 12 个字段，**相关的题目合并成一次调用**，不要先发草稿再补发。
- Codex 下改 MG 代码用 `edit_asset` + 内联 `json.code`；不能用 `codeFile`（这个 runtime 拿不到工作区文件）。

## 2. 视觉风格和音乐有"门禁"，但用户说"你决定"就跳过

- 项目没有 Design Style、用户也没指定风格时，`create-motion-graphics` 要求先给视觉预设选择器：`manage_design_style action="list_presets"` → 挑 3~6 个合适的 → 卡片选择 → `apply_preset`。它注明"选择器是回合边界，发完就停"。
- `music` skill 要求在明确人声/纯音乐之前先二选一，防止误生成带人声的歌。
- **豁免**：用户说过"直接做 / 你看着来 / 你自己决定就行"之后，可以自己做主并把选择讲清楚，不再追问。中文讲解/教程类视频选**纯音乐（instrumental）**基本不会错。
- 排期：**先提交付费的异步生成（音乐），再做本地能做的活（写 MG 代码）**，让生成在后台跑。

## 3. Design Style 的字体：中文必须做 CJK 映射

- 预设（如 "Orange Minimal / 暖橙活力几何"）的 heading 是 `Inter` —— 纯拉丁字体。
- 中文标题直接用会走 fallback，预览和云渲染还可能不一致。
- 做法：`search_fonts` 查 CJK 字体，把返回的**规范名原样**写进 `fontFamily`（这次用 `Noto Sans SC`；`Smiley Sans (custom)` = 得意黑也可用）。查中文名也搜得到。
- 套完风格记得 `manage_design_style action="get"` 拿完整 designSpec（颜色 role、motion 语言都在这），别只看预设名字。
- 不要在 MG 里写 `PingFang SC` / `system-ui` / `Microsoft YaHei` 这类机器字体。

## 4. 自动压低（ducking）靠轨道 role，别手动调音量

- 语音轨 `role:"anchor"`，音乐轨 `role:"follower"`；`audioRouting.duckDepthDb` **不要传**，让后端按时间线响度自己算（这次自动得出 −11.8dB）。
- **anchor 只能放在真正有语音的那条轨上。** 如果片头封面卡和正片放同一条 V 轨，anchor 的范围会覆盖片头，开场那段纯音乐会被一起压低 → 开场没声。
  - 正确摆法：封面卡放上层轨（V2），正片在 V1（= anchor），音乐在 A1（= follower）。
- 用实测对比验证压低是否生效：纯人声段的 `mean_volume` vs 人声+音乐段。这次 −20.4 → −20.1（+0.3dB），说明音乐确实垫在人声之下约 10dB。
- 生成的音乐通常很长（这次 154 秒），按时长裁剪 + `audioFadeIn` / `audioFadeOut` 收尾。

## 5. "封面图"可以一次给两样

成本几乎一样，能同时满足"平台封面"和"视频里看到封面"两种理解：

- 做成**全屏 Motion Graphic 当片头**：文字/颜色/字体都声明成可编辑属性，用户能自己改。
- 从成片里**抽一帧当平台封面 PNG**：`ffmpeg -ss 2.0 -i out.mp4 -frames:v 1 cover.png`。
- 抽帧时机要选在**动效已稳定、淡出还没开始**的那一帧。这次卡片 72 帧 / `fadeOut 0.35s`，抽 2.0s 正好；抽 1.2s 时第三条任务条还在入场，颜色偏淡。

## 6. 打开编辑器：内置浏览器与用户自己的 Chrome

- 先用 ChatCut 返回的 `browserHandoff.url` **原样**打开（`dockviewLayout=media`、`theme=codex`、`editor-boot-token` 都要保留）。
- **给用户看的干净链接**：去掉 `dockviewLayout` / `theme` / `editor-boot-token`，但按语言加 locale 段 —— 中文用户是 `<域名>/zh/<原路径>`，即 `/zh/editor/<projectId>`。
- `cua.createBrowserTab("iab", url)` 常报 `Timed out waiting for tab 1 to navigate to ...`，**这不是失败**：标签页已建好并在加载。用 `listTabs` 核对 URL 即可，别反复重试或据此判失败；ChatCut 冷启动本来就慢。
- 用户要在自己的 Chrome 里打开：先查端口 `curl -s --max-time 2 http://127.0.0.1:9222/json/version`，再开新标签页（新版 Chrome 的 `/json/new` **必须用 PUT**）：

```bash
ENC=$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' "$URL")
curl -s -X PUT "http://127.0.0.1:9222/json/new?$ENC"
```

  驱动细节见 `chrome-cdp-drive` skill。ChatCut 插件本身规定不要主动驱动系统 Chrome，除非用户明确要求。
- 项目只在 Chrome 里开着也照样能编辑——插件走 API，浏览器只是"看和手动调"的界面。但要保证**有一个已登录的编辑器标签页开着**：有些处理（如 AI 人声降噪）是在编辑器那一侧本地跑的（返回 `route:"frontend"` 即代表走的是编辑器）。
