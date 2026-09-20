---
name: wechat-db-decrypt
description: 解密微信(WeChat) 4.x 本地数据库、导出/备份/读取聊天记录时使用。覆盖密钥提取(4.0 内存扫描 vs 4.1+ LLDB 断点 CCKeyDerivationPBKDF)、SQLCipher/WCDB 解密，以及 message_0.db 数据模型避坑(real_sender_id 映射、Msg 表名=md5(username)、zstd 压缩正文、sysmsg XML 系统消息)。遇到「导出微信聊天记录」「解密微信数据库」「读取 message_0.db」「聊天记录备份」「WeChat chat history export / decrypt」等需求必读。
---

# 微信 4.x 数据库解密与聊天记录导出

本机已有跑通的现成脚本：`~/wechat-export/export_wechat.py`（增量导出 HTML）+ launchd 定时任务 `com.fq.wechat-export`。改需求先看它，别重写。

## 0. 先确认版本，再选密钥方案（最重要的分叉）

- **微信 4.0.x**：进程内存缓存明文 raw key（`x'<64hex key><32hex salt>'`），可内存扫描直接拿。
- **微信 4.1+**：内存**只留 passphrase**，真正的 key 是 `PBKDF2(passphrase, 每库 16 字节 salt, 256000 轮)` 现场派生；磁盘上的 `key_info.db` 里**不是**直接 key（别在它上面浪费时间试 sqlcipher）。

确认版本：
```bash
defaults read /Applications/WeChat.app/Contents/Info.plist CFBundleShortVersionString
```

## 1. 密钥提取（4.1+，macOS，已验证）

工具：wcdb-key-tool（`~/wechat-export/wcdb_key_tool_macos.py`，断苹果公开函数 `CCKeyDerivationPBKDF`，不逆向微信二进制）。

```bash
# ① 重签去 Hardened Runtime（否则 LLDB 读不了内存；微信更新后要重做）
sudo codesign --force --deep --sign - /Applications/WeChat.app

# ② LLDB 断点抓 passphrase，期间在微信里「退出登录→重新扫码登录」触发密钥重算
sudo python3 wcdb_key_tool_macos.py extract --decrypt
```

- passphrase 缓存 `~/.wcdb-key-tool/wechat-passphrase.json`（权限 600）。
- **之后解密不需要 sudo**，用缓存的 `all_keys.json` 直接：
  `python3 wcdb_key_tool_macos.py decrypt --keys all_keys.json --output <dir>`

## 2. 数据模型避坑（message_0.db）

- 库位置：`~/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/<wxid>_xxx/db_storage/`
- 消息表：`Msg_<md5(username)>`，username = 会话标识（wxid / `@chatroom` 群 / `@openim` / 自定义号）。
- **`real_sender_id` = message_0.db 里 `Name2Id` 表的 rowid**。⚠️ 不是 `contact.id`，也不是 `contact.db` 里的 `name2id` 表 rowid——这两张表共享插入顺序、id 恰好对齐，是经典陷阱（会把单聊误判成多人对话）。
- 会话/发送者显示名：username → `contact.remark`(优先) / `nick_name`。
- 自己的 wxid：数据目录名 `wxid_xxx_yyy` 里的 `wxid_xxx`。

## 3. 消息正文处理顺序（顺序错一步就解析失败）

1. `message_content` 若是 bytes 且开头 `28 B5 2F FD` → **zstd 解压**（这是 zstd magic）。
2. decode utf-8。
3. 剥 `发送者:\n` 前缀（群聊消息自带，正则 `^([A-Za-z0-9_@\-]+):\s*\n`）。⚠️ 系统消息解压后也带 `@chatroom:\n` 前缀，必须先剥。
4. 再按 `local_type` 解析：
   - `1` 文本；`3` 图片；`34` 语音；`47` 表情；`50` 视频（占位符）
   - `10000` 系统消息：新消息是 `<sysmsg>` XML 模板，解析 `<template>` 里的 `$xxx$` 占位符，用 `<link name="xxx">` 内的 `<nickname>` 替换。

## 4. 环境小坑

- `pip install zstandard` 会被 PEP 668 拦 → 用 ctypes 调系统库 `/opt/homebrew/lib/libzstd.dylib`（`ZSTD_getFrameContentSize` + `ZSTD_decompress`）。
- sudo 解密产物属主是 root，sqlite3 报 `unable to open database file (14)` → 非 sudo 解密；读库用 `file:...?mode=ro&immutable=1`。
- 微信自动更新后 Hardened Runtime 还原、key 可能重算 → 重签 + 重跑 `extract --decrypt`。

## 5. 安全边界

只用于**自己设备上自己账号**的数据库；拿到 passphrase/key 等于拿到全部聊天解密能力，产物文件别外传、别提交 git。
