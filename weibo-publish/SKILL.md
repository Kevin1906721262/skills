---
name: weibo-publish
description: 通过浏览器驱动微博(weibo.com)网页版发布视频——在「视频发布」页上传 mp4、填标题与微博正文、选类型(原创/二创)与内容声明、挑封面帧、点发布，再到个人主页核对。当用户说「发个微博」「把这个视频发到微博」「微博发视频/投稿视频」「帮我发条微博视频」时使用。当前只覆盖**带标题的视频发布**;不用于：图文/头条文章、超话、问答、管理已有微博(改权限/删除/置顶)、私信评论;也不用于发视频号(wechat-channels-publish)、B站(bilibili-publish)、抖音(douyin-publish)、小红书(xiaohongshu-publish)、快手(kuaishou-publish)、知乎(zhihu-publish)、闲鱼(xianyu-publish)。
---

# 微博：发视频

把本地视频发成一条微博。全程用 Chrome CDP 驱动已登录的浏览器（环境搭建、取页签、`cdp-eval` / `cdp-click` / `cdp-keys` / `cdp-shot` 见 skill **chrome-cdp-drive**）。

**只写视频发布。** 图文、头条文章、超话、问答走别的入口，本 skill 不覆盖。

## 前置

- 浏览器带调试端口（`curl -s --max-time 2 http://127.0.0.1:9222/json/version` 有 JSON）。
- **入口只有这个 URL**：`https://weibo.com/upload/channel`（页签标题「视频发布」）。
  - `https://weibo.com/upload/uploadVideo`、`https://weibo.com/upload/video` 都**不是**这个页面：会 302 到 `/upload` 并渲染成一个陌生人的个人主页（实测）。**别猜 URL。**
- 页面文案给的规格：≤15G、≥1080p 且 ≥1 分钟另有曝光加权；3.8MB / 32s 的视频秒传。
- **中文文件名先复制成 ASCII 路径**：
  ```bash
  cp "/Users/你/Desktop/任务管理2-封面音乐版-双语字幕版.mp4" /tmp/up.mp4
  ```
- **发布是不可逆的外部动作。** 只在用户明确说「发」时才点「发布」；用户只是要准备内容时，填完停下并告知。**用户没给标题/正文时先问**，别自己编。

## 两条发布路，要标题就走「视频发布」页

| 入口 | 能设什么 | 说明 |
|---|---|---|
| 首页发布框（`https://weibo.com/` 顶部，工具栏那排「图片/视频/话题」） | 只有**微博正文**，**没有标题字段** | 它的 `input[type=file]` 直接 `setFileInputFiles` **有效**（视频会变成发布框里的一张缩略图）。适合"随便发一条"，不适合"标题是 X"。 |
| `https://weibo.com/upload/channel` | **标题** + 微博正文 + 类型 + 内容声明 + 封面 + 分类 | 正文里的卡片会标「来自 微博视频号」。用户提到"标题"时走这条。 |

## ★ 三个必踩的坑

### 1. 上传必须走「文件选择框拦截」，直接塞 input 没用

视频发布页里的 `input[type=file]`（`_file_hqmwy_20`，`accept` 含 `video/*`，带 `multiple`）**直接 `DOM.setFileInputFiles` 会假成功**：脚本 `ok:true`、`filesAfter: 0`、页面纹丝不动停在拖拽区，**一条上传请求都没有**。

必须：真实点击「上传视频」按钮 → `Page.setInterceptFileChooserDialog` 拦下选择框 → 用 `Page.fileChooserOpened` 给的 `backendNodeId` 塞文件。现成脚本：

```bash
node ~/.agents/skills/weibo-publish/scripts/upload-video.mjs --ws "$WS" --file /tmp/up.mp4 --wait 8000
```

（对比：首页发布框那个 file input 直接塞是**有效**的 —— 所以"直接塞不管用"这件事是**页面级**的，不是微博级的。）

### 2. 内容声明的选项是假 checkbox，真实鼠标点不动

`类型` 的 `原创/二创` 是正常 `<label>`+radio，`cdp-click` 能点。但**内容声明的下拉选项**是 `<button class="_option_*">` + `<span class="_check_*">` 拼的假勾选框：

- 用 `cdp-click`（`Input.dispatchMouseEvent` 真实鼠标）点了**两次都没勾上**，坐标明明在元素上；
- 换 **`el.click()`（页面内 JS）立刻勾上**。

```js
// 勾「我的内容无需声明」→ 再点「确定」关闭面板 → 回读确认
(()=>{const b=[...document.querySelectorAll("button[class*=option]")]
    .find(x=>(x.textContent||"").trim()==="我的内容无需声明");b.click();return b.querySelector("span").innerHTML.slice(0,60)})()
```

**判据是 `span._check_*` 里出现了 `_checkMark_*`**（回读 button 的 innerHTML），不是"我点过了"。勾完必须再点面板底部的**「确定」**，下拉才会收起、字段才算填上。

选项一共 6 个：`我的内容无需声明` / `内容为转载` / `含AI生成内容` / `含虚构演绎内容` / `个人观点，仅供参考` / `内容含营销信息`。**这是事实性声明，别替用户乱选**：自己的原创内容就用「我的内容无需声明」，素材不明确时先问。

### 3. 默认封面是第 0 帧 = 淡入白帧

平台从视频里抽 ~9 帧，**默认选中的是第 0 帧**。实测这支视频 0s 是淡入白帧，直接发就是一张白封面。

封面条：`div.woo-picture-main[class*=a5item]`（数组顺序 = 帧顺序），当前选中项多一个 **`_a5itemcurr_*`** 类。点第 i 个即可换封面，**用 `_a5itemcurr` 落在哪个下标 + 主预览图 `src` 变了**两处一起回读确认。

**帧号 ≈ 时间：第 i 帧 ≈ i×4 秒**（32.5s 的视频给了 9 帧；已用 ffmpeg 抽同刻帧逐张比对确认）。这支视频 **第 6 帧（≈24s）**内容最完整 —— 有标题、面板和字幕，实测选它。挑帧时先 `ffmpeg -ss <t> -i video.mp4 -frames:v 1 out.jpg` 看一眼再决定。

## 标准流程

### 1. 上传

```bash
node ~/.agents/skills/weibo-publish/scripts/upload-video.mjs --ws "$WS" --file /tmp/up.mp4 --wait 8000
```

成功判据：页面文案出现 **`上传完成` / `3.66MB/ 3.66MB`**，并且 `类型`、`内容声明`、`标题`、封面、`分类`、`发布` 这些字段**从隐藏变成可见**（未上传时它们都在 DOM 里但 `offsetParent === null`，**别把"字段查得到"当成"表单出来了"**）。

### 2. 类型（必填）

`原创` / `二创` 两个 radio（`label.woo-radio-main`，文本精确匹配）。自有内容选 `原创`。回读 `[...document.querySelectorAll("input[type=radio]")].map(e=>e.checked)`。

### 3. 内容声明（必填）—— 见上面「坑 2」

### 4. 标题（0～30 字）

```bash
CDP_WS="$WS" CDP_FIND='document.querySelector("input[placeholder^=\"填写标题\"]")' CDP_TEXT='效率工具分享' \
  node ~/.agents/skills/chrome-cdp-drive/scripts/cdp-keys.mjs
```

回读 `input.value` **和**右侧计数器（`6/30`）。标题是视频卡片上的标题。

### 5. 微博正文（观众在 feed 里看到的那句）

`textarea._input_1rz8r_8`（placeholder「有什么新鲜事想分享给大家？」，和首页发布框是同一个组件）。同样用 `cdp-keys.mjs` 的 `CDP_FIND` + `CDP_TEXT`。

**用户说「标题是 X」时，正文一般也填 X**：微博 feed 里显眼的只有正文，正文留空的话卡片上就只剩一段视频。用户明确说"只填标题"时再留空。

### 6. 封面 —— 见上面「坑 3」

### 7. 其余字段：默认值就能用

`分类`（频道，**非必填**，标题旁没有 `*`）、`合集`、`关联原视频`、`划重点`、`设置 → 允许他人划重点/剪辑` 全部保持默认。`公开` 也别动，除非用户要求。用户没提频道时**不要**自己挑一个。

### 8. 发布与验证

发布按钮是 `<button>`（`woo-button-main ... woo-button-primary`，文本 `发布`），在页面最底部，`cdp-click` 自己会滚过去。点完页面立刻变成：

> 视频已上传成功，将在转码后发布，发布进度请查看视频管理 > 请留意来自 @微博视频 的私信通知

**这只是"提交成功"，不是"发布了"。** 转码要等一会儿，实测 **约 20~30 秒**后个人主页才出现这条。验证：

```bash
# uid 从页面读，别去找
CDP_WS="$WS" CDP_EXPR='String((window.$CONFIG&&$CONFIG.uid)||"")' node ~/.agents/skills/chrome-cdp-drive/scripts/cdp-eval.mjs
# 然后开 https://weibo.com/u/<uid>，回读第一条卡片
```

通过判据（实测形态）：

- `全部微博（N）` 比发布前 +1；
- 第一条卡片是 `奉钦_ | 刚刚 | 来自 微博视频号 | <正文> <昵称>的微博视频 | 00:32`；
- 封面是刚挑的那一帧，不是白图。

顺手 `cdp-shot` 一张卡片截图给用户看。**别只看"页面跳走了"就宣布成功。**

## 出问题时

- **点了「上传视频」但 `Page.fileChooserOpened` 没来**：说明点击没落在按钮上（页面上「上传视频」出现两次：大标题和小标题说明文案）。默认 `--find` 已经取了文本精确等于 `上传视频`、在视口内、面积最小的那个；要自己写就照脚本头部的模板。
- **表单一直不出来**：先看页面文案有没有 `上传完成`。停在 `拖拽视频到此处也可上传` 就是没塞进去（见坑 1）。
- **内容声明点了没反应**：确定是 `el.click()` 勾的、并且回读到了 `_checkMark_*`，最后点过「确定」。
- **发布后主页没有新微博**：先等 30 秒再刷；还在等就说明还在转码。**别重复点「发布」**（会多发一条）。
- **class 名里的哈希会变**（`_a5item_1gx9k_337`、`_option_nsgmr_213` 这类后缀是构建产物）。选择器一律用 `[class*=a5item]` / `button[class*=option]` 这种**模糊匹配**，别把哈希抄死。
- 更多实测 DOM 细节（含抓到的字段、封面 9 帧 URL、选项原文）见 [references/dom-notes.md](references/dom-notes.md)。
