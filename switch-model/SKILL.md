---
name: switch-model
description: 切换模型。当用户说"切模型/切pro/切flash"时，返回对应的 /model 命令。切pro → /model deepseek-v4-pro；切flash → /model deepseek-v4-flash；切模型（未指定）→ /model deepseek-v4-flash。
argument-hint: "切 flash / 切 pro"
---

# 模型切换命令

用户说切换模型时，按关键词返回对应命令：

| 关键词 | 命令 |
| --- | --- |
| 切 pro | `/model deepseek-v4-pro` |
| 切 flash | `/model deepseek-v4-flash` |
| 切模型（未指定目标） | `/model deepseek-v4-flash`（默认） |

## 行为

1. 识别用户话里的关键词：`切pro` / `切flash` / `切模型`
2. 只输出对应的 `/model` 命令，不要附加说明、不要自动执行
3. 若用户指定了目标（如"切到 pro"），按目标返回；未指定目标时按默认 flash 返回

## 常见触发示例

- "切模型" → `/model deepseek-v4-flash`
- "切 pro" / "切pro" / "帮我切到 pro" → `/model deepseek-v4-pro`
- "切 flash" / "切flash" / "切回 flash" → `/model deepseek-v4-flash`

> 注：`/model` 是内置命令，由用户手动回车执行。
