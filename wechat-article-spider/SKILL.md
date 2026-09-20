---
name: wechat-article-spider
version: 1.3.0
description: 微信公众号文章爬虫 - 将微信公号文章转换为 Markdown + 本地图片
---

# wechat-article-spider

微信公众号文章爬虫 - 将微信公号文章转换为 Markdown + 本地图片

## 执行指令

```bash
SKILL_DIR=~/.agents/skills/wechat-article-spider
$SKILL_DIR/.venv/bin/python $SKILL_DIR/scripts/main.py <文章 URL> [输出目录]
```

> 本机（macOS + Homebrew Python）无法全局 pip 安装依赖，已在本 skill 目录下建好
> `.venv`，requests / beautifulsoup4 / lxml 均已就绪，直接用上面的 venv python 调用。

## 功能

- ✅ 输入微信公号文章 URL
- ✅ 自动抓取文章内容
- ✅ 自动提取发布时间（`em.rich_media_meta_text` + script JSON fallback）
- ✅ 文件名自动带发布时间前缀（`YYYYMMDD-标题.md`）
- ✅ 下载所有图片到 `images/` 文件夹
- ✅ 生成 Markdown 文件，图片使用相对路径引用
- ✅ 正确分隔段落（`<section>` 按块级处理）
- ✅ 表格转换为 Markdown 表格
- ✅ 引用块（`<blockquote>`）递归处理子元素
- ✅ 粗体（`<strong>`）和斜体（`<em>`）保留
- ✅ LaTeX 公式（`data-formula` 属性）→ `$...$` 行内 / `$$...$$` 显示公式
- ✅ 代码块（`<pre>` 标签）→ ` ``` ` 围栏代码块
- ✅ 行内代码（`<code>` 标签）→ 反引号行内代码
- ✅ 标题内嵌图片（`<h1>-<h6>` 内的 `<img>`）提取为独立图片引用，不再丢失
- ⚠️ 图片渲染的公式（无 `data-formula`）保留为图片引用

## 安装

```bash
# 依赖已随 skill 装好（见上方 .venv）；如需重建：
python3 -m venv ~/.agents/skills/wechat-article-spider/.venv
~/.agents/skills/wechat-article-spider/.venv/bin/python -m pip install -r ~/.agents/skills/wechat-article-spider/scripts/requirements.txt
```

> 注意：`scripts/` 下的 `save_csloushi_article.py`、`save_aibiancheng_article.py`、
> `save_abutiongraph_article.py` 是 Windows 上写的站点专用适配脚本，`BASE_DIR`
> 硬编码了 `E:\...` 路径，在本机需先改成实际输出目录才能用。
> `main.py` 的默认输出目录解析为 `~/.agents/docs`，建议调用时显式传输出目录。

## 用法

### 命令行

```bash
python main.py <文章 URL> [输出目录]
```

### 示例

```bash
# 下载到当前目录
python main.py https://mp.weixin.qq.com/s/xxxxx

# 指定输出目录
python main.py https://mp.weixin.qq.com/s/xxxxx ./my-articles
```

## 批量抓取

`scripts/batch.py` 在单篇逻辑之上加了串行限速、失败重试、已抓过跳过、结果汇总。

```bash
SKILL_DIR=~/.agents/skills/wechat-article-spider
$SKILL_DIR/.venv/bin/python $SKILL_DIR/scripts/batch.py urls.txt <输出目录> \
    [--delay 8] [--retry 2] [--retry-wait 20] [--force]
```

- `urls.txt` 每行一个地址，支持裸 URL 或 Markdown 链接语法 `[标题](URL)`，空行和 `#` 注释忽略
- 默认每篇间隔 8 秒；微信有风控，不建议调到 3 秒以下
- 已抓过的文章按「原文链接」比对后跳过，加 `--force` 可强制重抓
- 每轮结束把成功/跳过/失败写进 `<输出目录>/_batch-report.md`
- 退出码：全部成功或跳过为 0，有失败为 2

## 找文章链接（搜狗微信搜索）

微信官方没有免登录的历史文章列表接口，`scripts/sogou_search.py` 走搜狗微信搜索。
搜狗结果页的 `/link?url=...` 是用 JS 片段拼出真实地址的，脚本会还原成
`mp.weixin.qq.com/s?src=11&...&signature=...` 并可直接喂给 `batch.py`。

```bash
$SKILL_DIR/.venv/bin/python $SKILL_DIR/scripts/sogou_search.py "关键词" \
    [--pages 2] [--delay 4] [--urls-only] [--out urls.txt]
```

- 关键词检索跨公众号，不是「某个号的全部历史文章」
- 每页约 10 条；翻页/解析过快会触发搜狗验证码，脚本会提示并停止
- 搜狗返回的 `signature` 有时效，拿到链接后尽快抓取

### 输出结构

```
output/
├── YYYYMMDD-文章标题.md
└── images/
    ├── img_001_xxx.jpg
    ├── img_002_xxx.png
    └── ...
```

## 注意事项

- 微信文章可能有反爬机制，如遇失败可稍后重试
- 部分动态加载的图片可能无法获取
- 图片文件名使用哈希值避免重复
- Windows 下需设置 `PYTHONIOENCODING=utf-8` 避免 emoji 打印 GBK 错误

## 版本历史

### v1.3.0 (2026-06-22)
- **关键修复**：`<h1>-<h6>` 标题标签内嵌套的 `<img>` 现在会被提取为独立图片引用
  - 之前 h1-h6 用 `get_text(strip=True)` 只取纯文本，完全跳过 img 子元素
  - 微信公号常把图片包在 `<h2><span><img></span></h2>` 里，导致图片静默丢失
  - 修复后先取标题文本，再把内部 img 提取为 `![](path)` 放在标题后面

### v1.2.0 (2026-06-22)
- 新增 `<pre>` 标签处理：代码块提取为 ` ``` ` 围栏格式（之前会被默认逻辑拆散成单 token 段落）
- 新增 `<code>` 标签处理：行内代码用反引号包裹

### v1.1.0 (2026-06-15)
- 文件名自动带 `YYYYMMDD-` 发布时间前缀
- 发布时间的提取增加 script JSON fallback（URL 编码的 `publish_time` Unix 时间戳）
- safe_title 长度从 50 扩展到 80，保留更多中文标点
- 修复 Windows 控制台 GBK 编码问题（需 `PYTHONIOENCODING=utf-8`）

### v1.0.0
- 初始版本

## 依赖

- requests
- beautifulsoup4
- lxml
