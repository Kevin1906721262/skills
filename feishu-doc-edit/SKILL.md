---
name: feishu-doc-edit
description: 用浏览器驱动已登录的飞书云文档(docx/wiki)——从云盘首页新建文档、读标题与全文、按块增删、把图文写进文档、插图与改稿。当用户给出飞书链接(my.feishu.cn / larksuite.com 的 wiki 或 docx)说"打开这个文档/读一下里面写了什么/把内容写进去/生成一篇图文文档/改一下这段",或说"新建一个飞书文档/帮我建一篇文档/写篇文档放到飞书/从云盘新建个文档"时使用。不用于飞书开放平台 API 或机器人开发。
---

# feishu-doc-edit — 用浏览器读写飞书云文档

把飞书 docx / wiki 页面当成可编程编辑器:读标题与正文、按块增删、按顺序追加"图文"内容。
**全程走浏览器**,不碰开放平台 API、不需要应用凭证——用的是自动化 Chrome 里已有的登录态。

## 前置条件

| 依赖 | 说明 |
| --- | --- |
| 自动化 Chrome(CDP) | 见 skill **chrome-cdp-drive** §0/§1。飞书登录态就在这个 profile;调试口默认 `9222`,可用 `--port=` 覆盖 |
| node ≥ 21 | 脚本只用内置 `WebSocket`/`fetch`,零依赖 |
| `swiftc` | 剪贴板工具首次调用时自动编译(Command Line Tools 自带) |

## 别绕开的五条链路

1. **富文本写入 = 系统剪贴板 + 真实 Cmd+V**,不要 DOM 注入或 `execCommand`。HTML 必须以 `text/html` flavor 进剪贴板(`scripts/setclip.sh` 负责);用 osascript 的 `«class HTML»` 会被当成纯文本,把 `<h2>` 原样贴进去。
2. **图片同样是剪贴板 + Cmd+V**:PNG 放剪贴板,飞书自己上传到 drive,粘贴点插入图片块。
3. **结构化 HTML 只有粘进"空段落"才会展开成多个块**(标题/列表/段落各成块);粘在已有内容的块里会被**拍平并进当前块**,样式全丢。所以每次粘贴前先把光标挪到文末空段落 —— `focus-end` 会做这件事并自检,`write` 每一步都自动做。(**空文档例外**:那时连块都还没有,`focus-end` 必然失败,改用「从零新建一篇文档」里的回车法。)
4. **正文是虚拟列表**:DOM 里只有可视块。读全文必须用 `outline`/`text`(内部滚动分片收集、按位置去重),不要指望一次 `querySelectorAll` 拿全。
5. **图片上传是异步的**:刚粘贴时 `src` 是 `data:image/png;base64,…`,保存/刷新后才变成 `internal-api-drive-stream.feishu.cn` 的 https 地址。**要证明图真的进库,必须 `reload` 后再看**。

## 命令

```bash
S=~/.agents/skills/feishu-doc-edit/scripts/feishu.mjs

node $S tabs                                   # 列出浏览器标签页
node $S open  'https://my.feishu.cn/wiki/XXXX' # 新开标签页并等正文就绪

node $S title   --doc=XXXX      # 标题 + URL + 是否可编辑(标题含零宽字符,已剥离)
node $S outline --doc=XXXX      # 全文块结构 [{type,text,image,y}] —— 读文档主力
node $S blocks  --doc=XXXX      # 当前可视块(快,用于确认光标附近发生了什么)
node $S text    --doc=XXXX      # 全文纯文本
node $S imgs    --doc=XXXX      # 全文图片(位置/尺寸/URL)
node $S eval    '<js>' --doc=XXXX

node $S write  /path/plan.json --doc=XXXX   # 按计划顺序追加图文
node $S remove '某段文字'       --doc=XXXX   # 删除含该文本的块
node $S clear  --yes           --doc=XXXX   # 清空整篇正文(危险)
node $S focus-end              --doc=XXXX   # 光标放到文末空段落(粘贴前的必要条件)
node $S click  '某段文字' start --doc=XXXX   # 点击含该文本的最小块:start/end/center
node $S key    meta+a delete   --doc=XXXX
node $S reload                 --doc=XXXX   # 重载并等正文就绪(验证保存/上传用)
```

`--doc=<wiki token 或 URL 片段>` 用来在多标签页里指定文档;只有一个飞书页面时可省略。`--tab=<子串>` 可按 URL 过滤任意页面,`--first` 取第一个匹配(多个候选时默认报错并列出,避免打错文档)。

新建文档不在命令表里——它要走云盘首页的点击流程,见下文「从零新建一篇文档」。

## 写一篇图文文档的标准流程

1. `open <链接>`(或 `tabs` 找到已开的页签)→ `title` 确认**可编辑**(`readOnly: true` 就别写,先跟用户说)。**没有链接、要新建文档** → 见下节「从零新建一篇文档」。
2. `outline` 读现状。要覆盖旧内容就先跟用户确认,再 `clear --yes`;要追加就直接 `write`。
3. 把配图先落盘(PNG;`ffmpeg -ss <秒> -i <视频> -frames:v 1` 抽帧),文案拆成若干段 HTML 文件。
4. 写 plan.json,`write` 执行(**文本段 → 图 → 文本段**的顺序天然把图文对齐)。
5. `outline` 核对块类型与顺序;`reload` + `imgs` 确认图片已进云(https)。

### plan.json

```json
{
  "steps": [
    { "html": "s1.html" },
    { "png": "img1.png" },
    { "html": "<h2>二、用法</h2>" },
    { "text": "这行会被包成 <p> 粘贴" },
    { "key": "enter" },
    { "wait": 2000 }
  ],
  "waits": { "html": 1800, "png": 6000 }
}
```

- 路径相对 plan.json;`html` 的值若指向已存在的文件就读文件,否则按内联 HTML 处理。
- 每一步粘贴前自动执行 `focus-end` 的等价逻辑(保证在空段落里粘贴);`blockedAppendPoints > 0` 说明有步骤没拿到干净的追加点,结果要人工复查。

## 从零新建一篇文档(冷启动)

用户没给链接、只说"新建一篇飞书文档"时:

1. `open https://my.feishu.cn/drive/home/`(同名页签常有多个,加 `--first`)。
2. 点首页的「新建」卡片 → 菜单里点「文档」→ 弹出**模板库对话框**(标题「新建到 我的文档库」)→ 点「新建空白文档」。新文档在**新标签页**打开,URL 形如 `https://my.feishu.cn/wiki/<token>`。
   - 菜单项点完**不会立刻有反应**:模板库是延迟弹出的、新页签也是延迟出现的。此时去 `tabs` 很容易误判"没点中",于是重复点击——而重复点击可能点到别的东西(模板卡片、悬浮按钮)。**约定:动作 → 等 1~2s → 截图复核 → 再决定重试**。
3. `title --doc=<token>` 确认为 `editable` 后再写内容。

**空文档是冷启动,和已有文档完全不同,别直接套 `write` 流程**:

- 正文里**一个 `.block` 都没有**(`.page-block-children` 是空的),`outline` 返回 `[]`,`ensureAppendPoint` 必然失败。此时 `write plan.json` 会 10/10 报 `blockedAppendPoints` 然后**静默把内容丢光 —— exit code 仍然是 0**。
- 让光标进正文的唯一可靠办法:**精确点中占位符文字「按"/"插入内容"」那一小块**(`.ai-block-write-placeholder`,约 100×24px)。点它右边的空白处会落进**标题 H1**(光标链里是 `page-block-title-empty`),不是正文。成功的标志:光标链出现 `text-block`,且 `.block` 数量由 0 变 1。
- 之后**别再用坐标点击维护追加点**,改用回车:粘贴 → `key enter` → 粘贴。粘贴完光标就停在最后一个块末尾,回车得到的空段落就是干净的追加点。这比 `ensureAppendPoint` 的"点最后块右下角"稳得多——那个位置在长段落里是空白区,还可能点到页面右下角的悬浮按钮(弹出飞书 AI 侧栏,抢走焦点并改变布局,后面每步都报 `caret not in a block`)。
- 长文**分段粘贴**:例如"前言+前半"一次、"后半"一次,中间插图;每粘完一段用 `eval` 数一下 `.block` 数量,不要等最后才发现丢了。

**验收铁律**:只要 `blockedAppendPoints > 0`,或压根没数过块数,就必须 `reload` + `outline` 复核块类型/顺序/图片,不信 exit code。

## 改文档标题

标题在正文块流之外(独立 H1),空标题时是 `.page-block-title-empty`,**不是** `.page-block-title`(按类名取元素要兼容两种)。

`insert '<新标题>'` 前先把光标点进标题(点在标题行的文字区域)。新建文档默认标题是「未命名文档」占位,**改标题等于重命名 wiki 节点**:用户明确要求、或文档本来就还没名字时再做,其余情况写完问一句再改。

## 排版约定(飞书侧)

- 正文标题用 `<h2>`(页面大标题是文档标题,别在正文里再放 H1);列表用 `<ul><li>`;图注单独一行,如 `<p><i>▲ 图 1:…</i></p>`。
- 图片是**块级**的,不能内联进段落,图注必须另起一行。
- 飞书上传时会把图压到 **1280px 宽**。整屏截图里的小字会变小,关键界面建议再补一张裁切放大图。
- 写完刷新一次页面:左侧大纲(章节导航)会自动出现,可以直接用它验收结构。

## 安全与边界

- 动内容前先 `outline` 留底;`clear` / `remove` / 覆盖既有正文前,把"要动哪些块"讲清楚并拿到用户确认 —— 飞书有版本历史,但别把它当回滚方案。
- **改文档标题等于改 wiki 节点名**:除非用户明确要求,保持原标题,写完问一句要不要改(文档本来就是「未命名文档」的新建文档,可以顺手定个名)。
- 只做用户交代的编辑:不要顺手点"分享、权限、删除文档、移动"这类按钮。
- 对外发送/分享类动作(分享给谁、发布)一律用户自己来。

## 排错

块类型对照、症状 → 原因 → 处理、脚本实现要点,见 [references/feishu-docx-dom.md](references/feishu-docx-dom.md)。
