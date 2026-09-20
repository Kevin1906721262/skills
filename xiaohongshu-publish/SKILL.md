---
name: xiaohongshu-publish
description: 通过浏览器驱动小红书创作服务平台，发图文笔记(「文字配图」生成卡片图)或**视频笔记**(上传 mp4)。当用户说「发一篇小红书」「帮我发笔记/发帖」「按这个文案发小红书」「文字配图发小红书」「把这个视频发到小红书」「发视频笔记」时使用。不用于长文/播客、开放平台 API 或笔记数据分析；也不用于发抖音(douyin-publish)、快手(kuaishou-publish)、知乎(zhihu-publish)、闲鱼(xianyu-publish)——但别的平台缺封面/缺图时按本 skill 生成卡片图。
---

# 小红书：发图文笔记 / 发视频笔记

把一段文案变成小红书卡片图并发布成图文笔记，或直接把一个视频发成视频笔记。全程用 Chrome CDP 驱动已登录的浏览器。

下面第 1~7 步是**图文**流程(文字配图 → 生成卡片图);**发视频**不生成卡片图，见文末「## 发视频笔记」。

## 前置

- 浏览器必须带调试端口（`curl -s --max-time 2 http://127.0.0.1:9222/json/version` 有 JSON）。环境搭建与取页签见 skill **chrome-cdp-drive**。
- 目标页签 URL 含 `creator.xiaohongshu.com`。没有就 `PUT /json/new` 打开入口链接。
- **发布是不可逆的外部动作**。只在用户明确要求发布时点「发布」；用户只是想准备好内容时，改用「暂存离开」并告知。文案以用户给的为准，不要自行改写、扩写或加话题标签。

## 标准流程

入口：`https://creator.xiaohongshu.com/publish/publish?source=official&from=menu&target=image`

页面默认停在「上传图文」tab（顶部还有 上传视频 / 上传图文 / 写长文 / 发播客，右上角有 草稿箱(N)，都不要碰）。

1. **进入文字配图** — 点按钮 `文字配图`（同级还有 `上传图片`，按文本精确匹配；按钮在 `.image-upload-buttons` 里）。
   进入后标题栏是「写文字」，中间是卡片编辑区，右下侧有「再写一张」。

2. **写文案** — 编辑器是 `div.tiptap[contenteditable=true]`（ProseMirror）。聚焦后把光标收拢到末尾，用 `document.execCommand("insertText", false, 文案)` 注入即可被框架接收；不必模拟键盘。卡片会实时换行预览，「生成图片」按钮由空文案的禁用态变为可用。

3. **生成图片** — 点底部 `生成图片`，等 5~10s（期间卡片中央显示「图片生成中」）。完成后进入「预览图片」页：左侧大图，右侧是卡片模板网格（基础 / 插图 / 涂写 / 涂鸦 / 边框 / 手写 …），「基础」模板下有「换配色」。默认模板通常够用；用户对样式有要求时在这里挑模板。

4. **下一步** — 点左下 `下一步`，进入发布表单页：`图片编辑 1/18`（缩略图 + 「编辑」）、标题输入框、正文编辑器（**正文已自动填入卡片文案**）、话题/用户/表情按钮、字数计数 `n/1000`。

5. **填标题** — 标题输入框是 `input[placeholder="填写标题会有更多赞哦"]`（上限 20 字），**默认是空的，不填无法发布**。用户没单独给标题时，用正文首句或同一句文案。这是 React 受控输入，必须走原生 setter：

   ```js
   const el = document.querySelector('input[placeholder="填写标题会有更多赞哦"]');
   el.focus();
   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "标题文案");
   el.dispatchEvent(new Event("input", { bubbles: true }));
   el.dispatchEvent(new Event("change", { bubbles: true }));
   ```

   填完截图核对标题、正文、卡片三者一致再发布。

6. **发布** — 底部固定栏里的 `发布` / `暂存离开` **在自定义元素 `xhs-publish-btn` 的 closed shadow root 里**：普通选择器查不到，`elementFromPoint` 只返回宿主元素，`querySelectorAll('*')` 也拿不到内部节点。必须用 CDP 的 DOM 域穿透：

   ```bash
   node ~/.agents/skills/xiaohongshu-publish/scripts/xhs-el.mjs \
     --ws "$CDP_WS" --text 发布 --tag BUTTON --click --shot /tmp/xhs_published.png
   ```

   脚本内部：`DOM.getDocument({depth:-1, pierce:true})` → 找文本节点 `发布` → 取其父节点（`BUTTON.ce-btn.bg-red`；`暂存离开` 是同级的 `BUTTON.ce-btn.white`）→ `DOM.getBoxModel` 取中心 → `Input.dispatchMouseEvent` 发真实 mousePressed/mouseReleased。**nodeId 只在单个 CDP 会话内有效**，取节点、取坐标、点击必须在同一个脚本里完成。

7. **确认结果** — 成功后页面显示「发布成功」插画，约 3s 后自动回到发布页。然后点侧栏 `笔记管理` 核对新笔记（标题、时间、状态 `审核中`）。发布成功以这一步为准，不要只看那个动画。

## 发视频笔记

图文那套是"文字配图 → 生成卡片图";视频完全不同:直接传 mp4,**默认封面是第一帧(基本必须改)**。

### 上传

- 入口:`https://creator.xiaohongshu.com/publish/publish?source=official&from=menu&target=video`(和图文只差 `target=`)。顶部 `上传视频 / 上传图文 / 写长文 / 发播客` 四个 tab,视频流程停在默认的 `上传视频`。
- 页面只有一个视频 `input[type=file]`(`accept=.mp4,.mov,.flv,…`),**`DOM.setFileInputFiles` 直接塞就认**(借用 douyin-publish 的同名脚本即可):
  ```bash
  node ~/.agents/skills/douyin-publish/scripts/set-file-input.mjs --ws "$CDP_WS" --file /abs/clip.mp4 --index 0 --wait 9000
  ```
- 成功判据:页面出现 `视频文件` + 文件名 + `检测为高清视频` 提示,下面是完整表单(`设置封面` / 标题 / 正文)。**`filesAfter` 照样是 0,别拿它判断成败。**
- 有时会出现一条 `不支持视频展示,请升级…` 的提示,不挡发布。

### 封面(默认取第一帧)

- `设置封面` 区:左边 `编辑封面`(当前封面)、右边 `智能推荐封面` 三张卡。
- **用推荐封面**:每张卡 `div.cover-image` 上 hover 出 `button.apply-btn`(文本 `应用`),点它 → 弹预览 → toast **`已应用推荐封面`**,左侧缩略图随即更换。三张里常有一张是黑帧,挑带内容的那张。
- 自己换:点 `编辑封面`(入口是 hover 才显示的 `div.cover-edit-entry`,直接 `el.click()` 也能触发,不必先 hover)→ 打开编辑器(左侧 `裁剪/模板/贴纸/文字/滤镜`,底部时间轴 + `+ 上传封面`,封面图的 `input[type=file]` 是 **`index 1`**,`accept=image/*`)→ 右上 `完成`。
- **验证看编辑器的评估结论**:**`封面效果评估通过,未发现封面质量问题`** 就是好的;有问题这里会直接报。

### 文案字段

- 标题 `input[placeholder="填写标题会有更多赞哦"]`,上限 20 字,**默认空,不填不能发布**,原生 setter 写法同图文那步(用户没给标题就用正文首句)。
- 正文 `div.tiptap[contenteditable=true]`。⚠️ **视频流程里正文是空的**(图文流程会自动带上卡片文案),要自己写。
- 写法见 skill **chrome-cdp-drive** §5.5:**`cdp-keys.mjs` 的 `CDP_SEL_END` + `CDP_TEXT`**(带 `\n` 分段),**不要用 `cdp-type.mjs`**。
- **话题必须逐字符真实按键**:`CDP_TYPE` 打 `#关键词` → 联想列表(`.item`,每项首行是话题名、第二行是"XXX万浏览")→ 点**首行等于 `#关键词`** 的那一项。
  - 已知话题:`#任务管理`(810.6万浏览)、`#效率工具`(3.1亿)、`#程序员`(43.1亿)、`#人工智能`(61亿)。
  - ⚠️ **没有 `#DeepSeek` 这个精确话题**(列表里只有 `#DeepSee…` 系列),遇到没有的就选最贴近的(如 `#人工智能`)。
  - ⚠️ **别用 `Input.insertText` 插关键词再选话题**:实测生成的 chip 会**多一个尾字**(`#任务管理` → chip 文本 `#任务管理 理`,`#效率工具` → `#效率工具 具`);换 `CDP_TYPE` 逐字符打就干净了。
  - chip 的 DOM 是 `a.tiptap-topic`,里面 `<span class="content-hide">[话题]#</span>` 是隐藏文本,`innerText` 里出现 `[话题]#` **属正常**,别当脏字符去删。

### 发布与验证

- 底部 `暂存离开` / `发布` 在自定义元素 **`xhs-publish-btn` 的 closed shadow root** 里(宿主 `innerHTML` 为空、`.shadowRoot` 是 `null`)——视频页和图文页是同一个宿主。**优先用本 skill 的 `xhs-el.mjs` 穿透点击**:
  ```bash
  node ~/.agents/skills/xiaohongshu-publish/scripts/xhs-el.mjs --ws "$CDP_WS" --text 发布 --click
  ```
  (本次视频发布是用坐标点过去的:1440×669 视口下 `发布` 中心约 `(742,622)`;坐标点击容易点到旁边的 `暂存离开`,能用脚本就用脚本。)
- 点完跳 `.../publish/success?…` 并显示 **`发布成功`**,几秒后自动回到发布页。**以这个为准**,别只看动画。

## 出问题时

（以下是**图文**专属的;发视频的问题见上面「发视频笔记」一节。）

- 点击后没反应：等 1~2s 再截图看当前状态，别连点（会点到弹层或别的元素）。必要时换 `el.click()` 与真实鼠标事件两种方式各试一次。
- 页面出现验证码 / 安全验证弹窗：截图告诉用户手动处理，不要自动解。
- 按钮位置、模板名、字数上限等 DOM 细节与常见卡点：见 [references/dom-notes.md](references/dom-notes.md)。

## 脚本

`scripts/xhs-el.mjs` —— 按文本查找/点击元素，能穿透 closed shadow root；同时用于「发布」和排查任何一个点不到的按钮。

```bash
# 只看命中（打印 tag/class/中心坐标/尺寸），不点
node .../xhs-el.mjs --ws "$CDP_WS" --text 发布
# 子串匹配（文案不完全确定时）
node .../xhs-el.mjs --ws "$CDP_WS" --text 暂存 --contains --click
```

其他步骤（写文案、填标题、生成图片）用 **chrome-cdp-drive** 的 `cdp-eval` / `cdp-click` 即可，不必自己写脚本。
