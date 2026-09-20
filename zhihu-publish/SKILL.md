---
name: zhihu-publish
description: 通过浏览器驱动知乎创作中心(www.zhihu.com/creator)网页版发布想法(图文 pin)——上传图片、写标题与正文、加话题、同步到圈子、点发布。当用户说「发篇知乎」「帮我在知乎发想法/发个图文作品」「把这张图发到知乎」时使用。不用于：写回答/写文章/发视频、管理已有内容(改权限/删除)、评论私信、知乎开放平台 API；也不用于发小红书(用 xiaohongshu-publish)、抖音(douyin-publish)、快手(kuaishou-publish)、闲鱼(xianyu-publish)。
---

# 知乎图文（想法 / pin）：图片 + 话题 + 圈子 → 发布

知乎的图文短内容叫**想法（pin）**，是唯一同时支持「图片 + 话题 + 圈子」的发布形态。全程用 Chrome CDP 驱动已登录的浏览器。

## 前置

- 浏览器必须带调试端口（`curl -s --max-time 2 http://127.0.0.1:9222/json/version` 有 JSON）。环境搭建与取页签见 skill **chrome-cdp-drive**。
- 入口：`https://www.zhihu.com/creator`。目标页签 URL 含 `zhihu.com/creator`；没有就 `PUT /json/new` 打开。
- **没有独立的想法编辑器 URL**：`https://www.zhihu.com/creator/publish/pin` 直接 404。编辑器就是创作中心首页那条「分享此刻的想法...」——点它**原地展开**成完整编辑器（标题 + 正文 + 工具栏 + 发布），不跳页也不弹窗。首页另有 提问题 / 写回答 / 写文章 / 发视频 四个入口，都不在本 skill 范围。
- **发布是不可逆的外部动作**。只在用户明确要求发布时点「发布」；用户只是想准备内容时，填完表单停下并告知（内容会自动存草稿）。文案、图片、话题以用户给的为准；用户没给就先问。

## 图片来源

优先用用户给的图（本地路径、对话里的图、截图）。缺图时按 skill **xiaohongshu-publish** 走「文字配图 → 生成图片」，到「预览图片」页取 `img.swiper-img` 的 `currentSrc` 下载原图，**不点「下一步」、不发小红书笔记**。

## 标准流程

### 1. 展开编辑器

点首页「开始创作」卡片里那条占位文案 `分享此刻的想法...`（未展开时是个纯 `div`，不是 contenteditable）。展开后同一块变成：标题 `textarea[placeholder="标题"]`、正文 Draft 编辑器、工具栏（`#` / 表情 / 图片 / 视频 / 投票）、`任何人都可以评论`、`同步到圈子`、`发布`。

**编辑器失焦会收起**回占位状态（点空白处、按 Escape 都可能触发）。收起**不丢内容**——再点一次占位文案，标题/正文/图片/话题都会回来；草稿也会自动存（右上角 `草稿箱(N)`）。

### 2. ⚠️ 双份 DOM：所有查找都要过滤可见

首页**同时挂着一份收起态的隐藏编辑器和一份展开态的可见编辑器**，两份 class 完全一样。`querySelector(...)` / `find(...)` 命中的通常是**隐藏那份**（`getBoundingClientRect()` 全是 0），按它算出的中心坐标是 `(0,0)`——真实鼠标点击会打在页头，页面毫无反应也不报错（实测第一次点击图片按钮就是这么静默失败的）。

所有 `CDP_FIND` 都带可见性过滤：

```js
[...document.querySelectorAll("button")]
  .find(b => { const r = b.getBoundingClientRect();
               return r.width > 0 && r.height > 0 && b.querySelector("svg.ZDI--Image24"); })
```

正文编辑器同理：`[...document.querySelectorAll(".public-DraftEditor-content[contenteditable=true]")].find(e => e.getBoundingClientRect().width > 0)`。

### 3. 标题与正文

- **标题**：`textarea[placeholder="标题"]`（React 受控）。点它聚焦后用 `cdp-type`（`CDP_TEXT=...`）真实输入最稳。实测标题不是发布的硬门槛（有正文就能发），但建议填——它会成为想法的大标题。
- **正文**：Draft.js 编辑器。先把光标收拢到末尾再注入：

  ```js
  const ed = [...document.querySelectorAll(".public-DraftEditor-content[contenteditable=true]")]
    .find(e => e.getBoundingClientRect().width > 0);
  ed.focus();
  const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  ```

  然后 `cdp-type` / `Input.insertText` 打字。实测这里没有小红书、抖音那种受控回写串字问题，一次注入到位。
- 删末尾多余字符要用**真实键盘**（`scripts/keys.mjs`）：先重新把光标收拢到末尾，再发 Backspace，别用 `execCommand("delete")`。

### 4. 上传图片

**没有「直接塞 `input[type=file]`」这条路**：页面里确实存在隐藏的 `input[type=file]`（accept 含 `image/*`，multiple），但 `DOM.setFileInputFiles` 之后 `files.length` 会变成 1、页面却毫无反应（不上传、不出现缩略图）。

真实路径是**工具栏按钮 → 弹窗 → 本地图片上传 → 文件选择框**：

1. 点工具栏里含 `svg.ZDI--Image24` 的按钮（从左数第三个，约 `y≈388`）。
2. 弹出「上传图片 / 公共图片库」弹窗，中间两个方块：`本地图片上传`（左）、`手机扫码上传`（右）。**只点「本地图片上传」**，点击它才弹系统文件选择框。
3. 用脚本吃掉这个文件选择框：

   ```bash
   node ~/.agents/skills/zhihu-publish/scripts/upload-via-file-chooser.mjs \
     --ws "$CDP_WS" --file /abs/path/card.jpg --wait 6000
   ```

   脚本默认就找 `本地图片上传`；需要换目标时用 `--find '<JS 返回要点的元素>'`。内部流程：`Page.setInterceptFileChooserDialog` → 真实鼠标点击 → 等 `Page.fileChooserOpened` 拿 `backendNodeId` → `DOM.setFileInputFiles`。
4. 上传完成后弹窗底部出现缩略图和 `1/18（最多上传 18 张图片）`，右下角 `插入图片` 按钮由禁用变可点。**必须点「插入图片」，图片才真正进想法**（直接关弹窗图不会进正文）。
5. 插入后编辑器里出现缩略图 + 一个虚线 `+` 方块（继续加图用），图片可拖动排序。

判据用**缩略图 + `插入图片` 可点**（脚本输出里的 `after.insertBtn` 为 `true`）；`after.fileInputs` 在这里是 0，不能当成功标志——文件选择框那个 input 不进 `document.querySelectorAll("input[type=file]")` 的 files 列表。

### 5. 加话题

1. 先把光标放到正文末尾（见第 3 步）。
2. 点工具栏含 `svg.ZDI--Hash24` 的按钮（从左数第一个）。它会在光标处插入一个 `#` 并弹出 `TopicSuggestion-Popover` 联想面板。
3. `Input.insertText` 输入关键词，面板按词过滤——**关键词打全**，别停在半截。
4. 点面板里的行：`.TopicSuggestion-Popover-container .Menu-item`，用行内 `.text` 的文本 `=== "#话题名"` 判定。
5. 校验：`ed.querySelectorAll("a.zed-topic").length` 等于话题数，每项带 `data-topic-id`。**只有变成 `a.zed-topic` 才算真话题**。

实测可用（2026-09-15）：

| 话题 | 讨论量 | topic id | 备注 |
|---|---|---|---|
| `#字幕` | 8.6 万 | 1434 | |
| `#字幕制作` | 1.8 万 | 68377 | |
| `#视频字幕` | 1.7 万 | 37029 | |
| `#双语字幕` | — | — | **知乎没有这个话题**，面板首行带 `创建新话题`，点它只插入纯文本 |

- 面板里带 `创建新话题` 标签的行 = 该话题不存在，点了只会往正文插一段纯文本 `#xxx`（不会生成 `a.zed-topic`）。想要真话题就选已存在的（如 `#中英双语字幕`），或接受正文里只是一段带 # 的文字。
- 每加完一个话题光标会停在话题后面，下一个重复「点 `#` → 输词 → 选行」即可。
- 加错/加多：光标收到末尾，用真实 Backspace 删（纯文本能删干净；已变成 `a.zed-topic` 且在最末尾时，一次 Backspace 整块删掉）。

### 6. 同步到圈子

点工具栏的 `同步到圈子`（文本精确匹配）。弹出 `选择圈子` 面板：

- 顶部搜索框（placeholder `查找更多圈子`）；右上角 `仅圈子可见` 开关**默认关**（= 公开可见），别乱动。
- 下面是 `推荐圈子` 列表，每行「图标 + 圈子名 + 简介 + `未加入` + `选择`」。**点行没用，必须点该行的 `选择` 按钮**；定位方式：先找 `.textContent` 包含圈子名的行容器，再取它里面的 `选择`。
- 选中后工具栏的 `同步到圈子` 变成蓝色圈子名（实测显示 `字幕组翻译前线`）。没有「取消」入口——要换就再点开面板选别的。
- **是否加入圈子不影响同步**：列表里都显示 `未加入`，选中照样能同步；发布后的想法上会挂一个圈子 chip，链到 `https://www.zhihu.com/ring/host/<id>`。

字幕相关圈子（实测推荐列表前三条就是）：`字幕组翻译前线`（字幕翻译与制作技术交流）、`字幕匠人`、`电影字幕学外语`。用户说「选字幕相关的圈子」时优先第一个。

### 7. 发布

工具栏右侧 `发布` 按钮（`BUTTON`，75×32，蓝色；左边是 `任何人都可以评论` 和圈子设置）。点完弹出成功弹窗：**「发布成功 · 感谢你的第 N 篇创作！」**，下面跟着分享面板（私信分享 / 复制链接 / 生成分享图 / 微信 / QQ）。

### 8. 确认结果 + 拿公开链接

- 到 `https://www.zhihu.com/creator/manage/creation/all` 核对：顶部 `共 N 条内容`，第一条是刚发的想法，展示正文（含 `#话题`）+ 缩略图 + 浏览/赞同/喜欢/评论数据 + `编辑 / 数据 / 查看评论 / 分享 / 删除`。
- 公开链接格式 `https://www.zhihu.com/pin/<id>`。**id 只能从内容管理页 DOM 里取**（页面上有 `/pin/<id>`、`/creator/analytics/work/pin/<id>` 这类 `<a href>`），创作中心没有别处直接显示 id：

  ```js
  [...new Set([...document.querySelectorAll("a")].map(a => a.href).filter(h => /\/pin\/\d+/.test(h)))]
  ```

## 出问题时

- **点了没反应**：九成是命中了隐藏的那份 DOM（坐标 `(0,0)`）。先 `getBoundingClientRect()` 看一眼，按第 2 步加可见性过滤。
- **图片进不了正文**：确认走的是「工具栏图片按钮 → 本地图片上传 → 文件选择框」；直接塞 `input[type=file]` 无效。上传完别忘了点 `插入图片`。
- **话题没变成链接**：该话题不存在（面板行带 `创建新话题`），或点到了行容器而不是 `.Menu-item`。
- **编辑器收起了**：点 `分享此刻的想法...` 重新展开，内容还在。
- 出现验证码 / 安全验证：截图让用户手动处理，不要自动解。
- 更细的选择器、坐标与实测记录见 [references/dom-notes.md](references/dom-notes.md)。

## 脚本

| 脚本 | 用途 |
|---|---|
| `scripts/upload-via-file-chooser.mjs` | 真实点击 + 拦截系统文件选择框 + `DOM.setFileInputFiles`。知乎的图片上传必须走它。 |
| `scripts/keys.mjs` | 发真实键盘事件（`meta+a` / `Backspace` / `Delete` / `Enter` / `Escape` / `space`）与 `Input.insertText`。用于删多余字符、挪光标。 |

```bash
node .../upload-via-file-chooser.mjs --ws "$CDP_WS" --file /abs/path/card.jpg [--find '<JS 返回要点的元素>'] [--wait 6000]
node .../keys.mjs --ws "$CDP_WS" --ops '[{"key":"Backspace"},{"text":"要输入的文本"}]'
```

其余步骤（标题、正文、话题词、读状态、截图）用 **chrome-cdp-drive** 的 `cdp-eval` / `cdp-click` / `cdp-type` / `cdp-shot` 即可。

## 已发布样例（2026-09-15）

想法：标题与正文都是 `可配字幕、双语字幕、字幕校准、字幕处理`，图片 1 张（小红书文字配图生成的 1200×1600 卡片），话题 `#字幕` `#字幕制作` `#视频字幕`，圈子 `字幕组翻译前线`。
链接：https://www.zhihu.com/pin/2083102828277638313
