---
name: wechat-send-message
description: 在 macOS 上操作微信桌面版给指定联系人发一条文本消息（搜索联系人 → 打开会话 → 粘贴 → 回车发送），并在发送前用辅助功能树校验收件人和草稿。当用户说「给 XX 发微信 / 发条微信 / 在微信里告诉 XX / 帮我发微信消息」时使用。不适用于发朋友圈、群公告、文件/图片、公众号、微信读书，也不适用于其他消息类 App。
metadata:
  short-description: 用 AppleScript 驱动微信发消息
---

# 微信发消息（macOS 桌面版）

## 先判断走哪条路

Codex 自带的「电脑操作 / Computer Use」在本机**用不了**：它依赖的 `SkyComputerUseService` 是按 macOS 14.4 编译的，而本机是 macOS 13.7.8，启动即崩溃（`Library not loaded: /usr/lib/swift/libswiftObservation.dylib`）。`cua.getApp("WeChat")` 只会返回 `Sky Computer Use service startup request failed`，重试和重置都没用，别在这上面浪费时间。

所以微信一律走 **AppleScript + System Events 辅助功能操作**（用户已明确授权用这条路操作微信）。前提：

- 微信已运行且已登录；
- 执行 `osascript` 的进程已获得「辅助功能」权限。一句 `osascript -e 'tell application "System Events" to get name of every process whose frontmost is true'` 能返回名字就说明有权限；
- 传文件/看图需要「屏幕录制」权限（`screencapture` 用得到）。

## 关键事实

微信把两个关键输入框暴露在辅助功能树里，这就是整套流程可以不靠鼠标坐标的原因：

- 搜索框：`AXTextArea`，**name 固定是「搜索」**；
- 消息输入框：`AXTextArea`，**name 等于当前打开会话的标题**（联系人昵称或群名），**value 就是输入框里的草稿**。

由此：打开会话后 `name` 必须等于收件人，发送前 `value` 必须等于要发的内容 —— 收件人和草稿都能发前校验，这是本 skill 的安全底线。

## 做法

直接用脚本，别手搓 osascript：

```bash
scripts/send_wechat_message.sh "<收件人>" "<消息>"            # 真发
scripts/send_wechat_message.sh "<收件人>" "<消息>" --dry-run  # 只走到校验，不按发送
scripts/wechat_ax_probe.sh                                    # 打印窗口几何 + 所有 AXTextArea
```

脚本内部就是三步：把收件人粘进搜索框 → 回车打开第一条结果 → 粘消息、校验草稿、回车发送。退出码：`2` 微信没开、`3` 会话没打开或标题对不上、`4` 草稿校验失败、`5` 发送后草稿还在。

首次在新联系人上用、或微信改版后界面变了，先跑 `wechat_ax_probe.sh` 确认搜索框和输入框还在、name 规律没变。

## 踩过的坑（照做就行）

- **中文不能用 `keystroke` 输入**：`keystroke "三思而后行"` 会变成 `a'a'a'a` 这种乱码。一律「写剪贴板 + `Cmd+V`」粘贴。脚本会先备份并还原用户剪贴板，自己写临时代码时也要还原。
- **不要再费劲点鼠标**：消息列表的行是 `AXStaticText`，无 name、无 action，`click at {x,y}` 点了两次都选不中会话；但键盘 100% 好用。所以走「搜索 + 回车」，不要走「点列表某一行」。
- **`UI elements` 是 System Events 的术语**：在 handler 里用 `count of UI elements of e`、`UI element i of e`，整个 handler 体必须包在 `tell application "System Events"` 里，否则报 `预期是 given/with/without…`，且报错位置是字符偏移、看起来像「第 881 行」，别被误导。见 [scripts/wechat_ax.applescript](scripts/wechat_ax.applescript)。
- **搜索框 → 回车 = 打开第一条结果**：名字同时命中联系人、群聊、聊天记录时，第一条固定是「联系人」，回车即进正确答案。打开后用输入框的 name 兜底，不是收件人就中止。
- **残留状态要清**：上一轮搜索会留下下拉浮层，而且浮层打开时窗口的辅助功能结构会变（`window 1` 直接从 `group 1` 变成单个 `AXList`），硬编码路径会突然 `无效的索引 (-1719)`。所以脚本先按 Esc，再让「聚焦 + `Cmd+A` + Delete」清空搜索框，永远靠递归按 name 找控件，不要记路径。
- **消息不能带换行**：粘贴的换行会在半截触发发送。脚本直接拒绝多行消息。
- **发送键**：微信默认回车发送；脚本回车后发现草稿还在，会自动补一发 `Cmd+Return`（有些人把发送键改成了 Cmd+回车）。

## 授权与确认

**常驻例外：给「三思而后行」发消息不需要再跟用户确认。** 这是用户 2026-09-19 明确给出的长期授权（发什么内容仍以用户当次说的为准）。用户想看的是结果，不要在发前再问一遍。

其他收件人仍按默认规矩：发送前的确认要留到最后一步（消息已经粘进输入框、只差回车时）再问，别提前问。无论发给谁，发完都要报告「发给谁、发了什么」，失败时按退出码说清楚卡在哪一步。
