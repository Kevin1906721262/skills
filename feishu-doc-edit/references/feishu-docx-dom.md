# 飞书 docx 页面结构与排错

实测环境:my.feishu.cn 知识库页面(wiki 链接会就地渲染成 docx 编辑器),Chrome 152,macOS。

## DOM 事实

- 正文编辑区:`[contenteditable=true]`(页面里可能有多个,正文块是它下面的 `.block`,可视块类名带 `docx-` 前缀)。
- 滚动容器:`.bear-web-x-container`(`scrollHeight` 是全文高度,`scrollTop` 用于分片扫描)。
- **虚拟列表**:只有可视块在 DOM 里。滚动到某处再 `querySelectorAll('.block')` 才能看到那一段。
- 文档标题是独立元素(不在正文块流里),`document.title` 形如 `标题 - 飞书云文档`;标题文本混入零宽字符(`U+200B–U+200F / U+202A–U+202E / U+2060–U+2064 / U+FEFF`),取值前要剥掉。
- 图片块里是 `<img>`;未上传完是 `data:image/png;base64,…`,完成后是 `internal-api-drive-stream.feishu.cn/...`。
- **标题元素类名会变**:空标题是 `.page-block-title-empty`,有内容后是 `.page-block-title`(都带 `page-block-content left flash-block-content`)。按类名取元素要兼容这两种,否则会 `null.getBoundingClientRect`。
- **空文档里没有任何正文块**:`.page-block` 里只有 header(「添加图标 / 添加封面」+ 标题 H1 + 作者行),正文容器 `.page-block-children` 是空的,`.block` 数量为 **0**。此时 `outline` 返回 `[]`。
- **正文占位符有两层**:`.first-line-placeholder`(撑满内容列宽)和 `.ai-block-write-placeholder`(只有「按"/"插入内容"」文字那一小块,约 100×24px)。**只有点中后者才能把光标送进正文**,点前者右侧的空白会落进标题 H1。
- **别缓存坐标**:内容列左边界随 wiki 侧边栏的展开/收起在 ~110 和 ~310 之间跳(宽度 820 不变),同一会话里都会变。每次点击前重新取 `getBoundingClientRect`。

### 常见块类型(`.block` 上的类)

| 类名(节选) | 含义 |
| --- | --- |
| `docx-text-block` | 正文段落 |
| `docx-heading1-block` / `docx-heading2-block` / `docx-heading3-block` | 一/二/三级标题 |
| `docx-bullet-block` / `docx-ordered-block` | 无序/有序列表(文本自带 `• `/`1. ` 前缀) |
| `docx-image-block` | 图片块(内含 `img`) |
| `docx-text-block isEmpty` | 空段落(粘贴前要找的落点) |
| `docx-quote-block` / `docx-code-block` / `docx-divider-block` | 引用 / 代码 / 分割线 |

## 从云盘首页新建文档(实测路径)

`https://my.feishu.cn/drive/home/` → 点「新建」卡片(文字「新建 / 新建文档开始协作」)→ 下拉菜单(文档 / 表格 / 幻灯片 / 多维表格 / 问卷 / 思维笔记 / 更多类型 / 文件夹 / 文档应用)→ 点「文档」→ **模板库对话框**(「新建到 我的文档库」,左侧模板分类、中间推荐、左上角有个「新建空白文档」的 + 卡片)→ 点「新建空白文档」→ **新标签页**打开 `https://my.feishu.cn/wiki/<token>`,标题为「未命名文档」。

- 菜单项/卡片的文字都在内层 `<span>` 上,点它本身能触发,但**触发是延迟的**:点完立刻 `tabs` 不会看到新页签,过 1~2s 模板库才弹出来、文档页签才出现。误判"没点中"而重复点击,会点到弹层里的别的东西。
- **「新建」下拉菜单的 11 个 `li.ud__menu-item` 常驻在 DOM 里,但位置会变**:没展开/没定位好时它们**停靠在屏幕外**(`x≈-9994, y≈-9995`,尺寸仍是满的 262×40,`UGLYHACK_menu-item-holder` 那套);就绪后是 `x≈297, y≈144`(第一项「文档」)。**判据是坐标,不是等待时长**——同一页签里实测有的 2s 到位、有的 3.5s 还停靠着。只按"尺寸 > 10px"筛会选中停靠那份,点下去等于点在弹层外面,菜单被静默关掉,表现成"点了完全没反应"。筛候选必须加"**在视口内**"(`left>=0 && top>=0 && right<=innerWidth && bottom<=innerHeight`);取不到候选就别点,先 `Page.bringToFront` 或关掉重开这个菜单,重读坐标变正再点。
- **对话框弹出后,截图里可能残留一层半透明的旧菜单**:同一位置隔 2s 重截一次就干净了,是合成器的残留帧。别据此判断"点错了、菜单和对话框叠一起了",更别因此重开一遍流程。
- 首页常同时开着多个一模一样的 `drive/home` 页签,不加 `--first` 时脚本会报"匹配到 N 个标签页"。新建完的文档页签用 URL 里的 token 定位最稳。

## 症状 → 原因 → 处理

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| 粘贴后出现 `<h2>标题</h2>` 这样的裸标签 | 剪贴板只有纯文本 flavor:osascript 的 `{«class HTML»:h, string:t}` 并没真正写入 `text/html` | 改用 `scripts/setclip.sh html <file>`(NSPasteboard 写 `text/html`) |
| 多段内容被并进一段,标题/列表样式全丢 | 光标停在**非空**块里,结构化 HTML 被拍平 | 粘贴前 `focus-end` / 让 `write` 自动处理;确认光标所在块是 `isEmpty` |
| 内容没出现在文末,反而插进某段中间 | 点击落点是块中心而非块尾 | 用 `click '<文本>' end`(末行右端)并核对返回的 `caret.atBlockEnd` |
| 图片刷新后消失,或正文改动丢失 | 上传/保存是异步的;`data:` 预览不代表已入库 | `reload` 后重看:图片 `src` 应为 https,页头显示"已经保存到云端" |
| `outline` 少块 | 滚动步长过大或页面还在渲染 | 脚本用 420px 步长 + 380ms 等待;仍缺就重跑一次 |
| 图片里的小字看不清 | 飞书把上传图压到 1280px 宽 | 关键界面裁切后放大(如只截面板区域),或"整屏 + 局部放大"两张 |
| `click` 报找不到文本 | 目标块在可视区外,虚拟列表没渲染它 | 先 `outline` 定位大致位置,再 `eval` 设 `scrollTop` 滚到附近后点击 |
| `title` 返回 `readOnly: true`,粘贴无效 | 只读权限或未登录 | 停手告诉用户,不要尝试绕过权限 |
| 新文档 `write` 报 10/10 `blockedAppendPoints`,内容静默丢光,exit code 还是 0 | 空文档里正文一个块都没有,追加点无从谈起;而且占位段的 `innerText` 含「按"/"插入内容"」,`empty` 被判定成 false | 先按「空文档冷启动」配方点出第一个块,再"分段粘贴 + 回车"手工追加;收尾必须 `reload` + `outline` 复核 |
| 想点正文却落进标题(光标链是 `page-block-title-empty`) | 点在了标题 H1 的可点区域;正文占位符只有文字那一小块可点 | `eval` 取 `.ai-block-write-placeholder` 的 rect,点它中心;成功标志是光标链出现 `text-block` |
| 每步都报 `caret not in a block`,还莫名弹出飞书 AI 侧栏 | `ensureAppendPoint` 的坐标点击落在长段落右下角的空白区,连带点中页面右下角悬浮按钮,抢焦点 + 改布局 | 改成"粘贴 → `key enter` → 粘贴":粘贴后光标就在末尾块,回车得到的空段落是干净追加点 |
| 整页截图里正文挤成极窄一列,像布局坏了 | `Page.captureScreenshot` 的 `captureBeyondViewport` 会临时改视口触发 reflow | 判断布局用普通视口截图 + `getBoundingClientRect`;整页截图只看全貌 |
| 点完菜单/新建,`tabs` 查不到新页签 | 模板库对话框与新页签都是延迟出现的 | 动作 → 等 1~2s → 截图复核 → 再决定重试;别马上重复点击(会点到别的东西) |
| 点「文档」没反应,而且菜单自己收起来了 | 选中了还停靠在 `x≈-9994` 的菜单项(弹层尚未就绪),真实鼠标事件落在弹层外面,等于"点空白关闭弹层" | 候选元素加"在视口内"过滤,并在点击前 dump 一次坐标确认是正数;取不到就重开菜单,别用固定等待时长兜底。详见上节「从云盘首页新建文档」 |

## 关键按键派发

CDP `Input.dispatchKeyEvent` 派发的按键算可信输入,能触发编辑器快捷键,但编辑命令要显式声明:

```js
// Cmd+V / Cmd+A —— commands 让 Chromium 直接执行编辑命令,而不是只发键码
{ type: "rawKeyDown", key: "v", code: "KeyV", windowsVirtualKeyCode: 86,
  nativeVirtualKeyCode: 9, modifiers: 4, commands: ["Paste"] }
{ type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65,
  modifiers: 4, commands: ["SelectAll"] }
```

`modifiers`:Meta=4、Shift=8、Alt=1、Ctrl=2。

## 有用的编辑配方

- **空文档冷启动**(从云盘首页新建、正文一个块都没有时):点 `.ai-block-write-placeholder` 中心 → 确认 `.block` 由 0 变 1 → 粘贴第一段 HTML(会展开成多个块)→ `key enter` 补空段落 → 插图 → 再 `key enter` → 粘贴第二段。全程用回车维护追加点,不要用坐标点击。
- **清空整篇**:点正文 → `Cmd+A` `Cmd+A` → `Delete`(第一次全选当前块内容,第二次全选全文)。必须先确认光标在正文里,否则会选中别的东西。
- **删掉某一段**:`click '<文本>' start` → `Cmd+A` → `Delete` → `Backspace`。标题块要多退一次:第一次退格把标题降级成段落,第二次才把空块并掉 —— `remove` 命令按"文本消失 **且** 光标不在空块里"判定完成。
- **在文末追加**:`focus-end`(点最后一行右端 → 自检 `caret.atBlockEnd` → 回车开空段落)→ 粘贴。图片粘贴后飞书会自动留下一个空段落,所以"图 → 文本"的连续粘贴天然安全。
  - 前提是**文档里已经有块**。空文档上 `focus-end` 必然失败;长段落(单块几百 px 高)上点"右下角"也容易落空或点中悬浮按钮。这两种情况一律改用"粘贴 → `key enter`"。
- **改文档标题**:点标题行的文字区域 → `insert '<新标题>'`。新建文档的标题占位是「未命名文档」,改它等于重命名 wiki 节点 —— 文档本来就没名字时可以顺手定名,否则先问用户。

## 光标探针

判断"光标到底在哪"是这套流程的自检核心,`feishu.mjs` 内部用它:

```js
const sel = getSelection();
const block = sel.anchorNode.parentElement.closest('.block');
const r = document.createRange();
r.selectNodeContents(block);
r.setEnd(sel.anchorNode, sel.anchorOffset);
r.toString().length              // 光标在块内的字符偏移
block === [...document.querySelectorAll('[contenteditable=true] .block')].pop()   // 是否在文末
```

偏移等于块长度 ⇒ 光标在块尾;块文本为空 ⇒ 是空段落,可以安全粘贴结构化 HTML。

**例外**:空文档里那个"空段落"的 `textContent` / `innerText` 是占位文字「按"/"插入内容"」,按文本判空会得出 `empty: false` 的假阴性。冷启动阶段不要依赖这个判据,改看 `.block` 数量与光标链里的类名(`text-block`)。
