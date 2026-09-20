---
name: deepseek-balance
description: 查询 DeepSeek 账户余额。当用户说"查余额/还有多少钱/余额多少/够不够用/查 API 余额"时使用。自动发现本机上所有 DeepSeek API Key 并逐个查询，支持阈值告警。
argument-hint: "[--threshold 5] [--key sk-xxx] [--json]"
---

# DeepSeek 余额查询

调用官方端点 `GET https://api.deepseek.com/user/balance`（Bearer 鉴权）。

## 用法

```bash
python3 ~/.agents/skills/deepseek-balance/scripts/deepseek_balance.py
```

## 关键行为：自动发现多个 Key

本机存在**两个来源**的 Key，必须都查 —— 否则可能看错账：

| 来源 | 用途 |
| --- | --- |
| 环境变量 `DEEPSEEK_API_KEY` | 手工调用 |
| `~/.claude/settings.json` → `env.ANTHROPIC_AUTH_TOKEN` | **Claude Code 实际烧的就是这个** |

> 截至 2026-09-12 实测：本机两个 Key 指向**同一账号**。但这不保证永远如此，换 Key 后要重新确认。

## 参数

| 参数 | 说明 |
| --- | --- |
| `--key sk-xxx` | 只查指定 Key，跳过自动发现 |
| `--threshold N` | 任一账户总余额 < N 时退出码 `1`（用于定时监控） |
| `--json` | 输出原始 JSON，便于脚本消费 |
| `--timeout N` | 请求超时秒数（默认 20） |

退出码：`0` 正常 / `1` 低于阈值 / `2` 没找到 Key。

## 响应字段

- `is_available` — 账户是否可用。**为 false 时 chat 调用会直接返回 402**，不是降级
- `balance_infos[]` — 按币种（`CNY` / `USD`）分列
- 金额全是**字符串**，参与数值计算前必须转换

## 实现要点（踩过的坑）

1. **用 curl 取数，不用 python urllib。** 本机代理链带自签证书，curl 走系统钥匙串能验通，python 自带 CA bundle 会报 `CERTIFICATE_VERIFY_FAILED`。
2. **端点不在 `/anthropic` 下。** Claude Code 走的是 `https://api.deepseek.com/anthropic`，但余额端点在 `api.deepseek.com` 根路径。
3. **输出要打码 Key**，只显示前 8 位，避免完整 Key 落到终端记录里。

## 定时监控（如需）

```bash
# 每天早上 9 点检查，低于 5 元退出 1
python3 ~/.agents/skills/deepseek-balance/scripts/deepseek_balance.py --threshold 5
```

配合 `/loop` 或 `CronCreate` 使用即可。

## 相关

- 切模型用 `switch-model` skill
- 余额为 0 时 Claude Code 会开始报错，别等到那时候
