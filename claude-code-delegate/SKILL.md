---
name: claude-code-delegate
description: 把任务交给本机的 Claude Code CLI（用户口中的「claude 子 Agent」）执行，并把它的回复原文取回。当用户说「用 claude 子 Agent 处理 X」「启动我的 claude / 让 claude 去做 X」「去 claude 里跑一下 X」，或要求在其中先切到 pro / flash 模型时使用。用户只说「用子 Agent」「派个子 agent」「并行开几个 agent」而没有点名 claude 时不要用本 skill——那指的是 Codex 自己的多 agent 机制。
---

# 把任务委派给本机 Claude Code

用户点名的「claude 子 Agent」就是本机的 `claude` 命令行（Claude Code CLI），不是 Codex 的子 agent。本 skill 负责启动它、必要时切模型、把任务发过去，并把回复原文取回来。

## 边界

用：用户点名要用 claude / Claude Code 处理任务，或要求在 claude 里先切模型（pro / flash）再干活。

不用：用户只说「用子 Agent」「派个子 agent」——那是 Codex 自己的 `spawn_agent` 等机制，跟 Claude Code 无关。

## 环境事实

先确认，不要假设：

- 可执行文件 `/usr/local/bin/claude`，`claude --version` 确认在。
- 配置 `~/.claude/settings.json`，本机走 DeepSeek 的 Anthropic 兼容端点。可用的模型名从 settings.json 的 `model` / env 里的 `ANTHROPIC_MODEL` 读，本机是 `deepseek-v4-flash` 和 `deepseek-v4-pro`。
- 「切 pro / 切 flash」的映射见 `~/.agents/skills/switch-model/SKILL.md`：切 pro → `/model deepseek-v4-pro`。
- 会话转录写在 `~/.claude/projects/<cwd 的斜杠换成短横线>/<session-id>.jsonl`；assistant 记录里的 `message.model` 就是这次真正作答的模型，`/model` 命令的确认输出也会作为一条 user 记录留在转录里。

转录是唯一可信的结果来源：抓屏一律不可信。

## 硬约束

1. 不要把交互式 `claude` 挂到自己的终端上（也就是别用 `exec_command(tty: true)` 直接跑 `claude` 本体）。TUI 的输出会被当成你自己的输出，实测两次把子 agent 的最终回答污染成了 Claude 的欢迎语。
2. 不要用 `screen` 驱动。本机没有 tmux；`screen` 的渲染与输入会错位（键入的字符会覆盖状态栏文字），`screen -X stuff` 加 hardcopy 抓屏都不可信。
3. 结果从 JSONL 转录里取，逐字，不要转述。
4. 不要改 `~/.claude/settings.json` 或任何配置；不要杀用户原本就在跑的 claude 进程，只收尾自己起的那个。

## 标准流程

用 `scripts/claude_pty_run.py`。它给 claude 一个独立于你终端的真 pty，按顺序发 `/model`（可选）和任务，再从转录里取回回复，同时把原始 TUI 输出落盘。

```bash
python3 ~/.agents/skills/claude-code-delegate/scripts/claude_pty_run.py \
  --cwd /Users/fq/IDEA \
  --model deepseek-v4-pro \
  --prompt "你好"
```

- `--model` 会先发 `/model <name>` 再发任务；用户说「用命令切到 pro 模型」时就是这一步。
- 不加 `--model` 就不发模型命令，直接用会话默认模型。
- 结束时脚本会 `/exit` 并清掉自己起的进程。
- 输出含：回复原文、作答模型、`/model` 确认证据、转录路径、原始日志路径。

一次性、不需要 slash 命令也不要求看交互过程的简单任务，可以用 headless：`claude -p "<任务>" --model <name>`。但要走这条就明确告诉用户这是 `--print` 模式，且用户点名「用命令切模型」时仍走 pty 流程。

## 回报给用户

1. 实际执行的命令序列（启动命令、`/model` 那一行、任务内容）。
2. 模型证据：`/model` 的确认输出（形如 `Set model to <name> and saved as your default for new sessions`）加上转录里 assistant 记录的 `message.model`。
3. Claude 对任务的回复原文，逐字，不翻译不润色，用代码块给出。
4. 转录文件的可点击路径。
5. 副作用说明：`/model <name>` 会顺带把该模型存成新会话的默认值。
6. 如果走了 headless 兜底或中途失败，如实说明走的是哪条路、卡在哪。

## 失败处理

- 启动慢：Claude Code 首次加载插件可能要几十秒，用 `--boot-seconds` 加大等待。
- 转录没新增文件：说明消息没提交进去，重跑即可；不要因此改用 screen 或 tty。
- 没等到 assistant 文本：看脚本打印的 raw log 路径确认 TUI 当时的状态，再用 `--timeout` 放宽重试。
