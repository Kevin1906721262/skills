# DOM 细节与实测记录（2026-09-15 实测）

知乎创作中心是 React + Draft.js，类名是编译后的哈希（`css-xxxx`），改版就会变。下面的值用来出问题时定位，不要当硬约束；**判据优先用文本 + 可见性**。

## 创作中心首页（`https://www.zhihu.com/creator`）

收起态与展开态是**两套并存**的 DOM：

| 状态 | 元素 | 实测 |
|---|---|---|
| 收起 | 占位文案 `div.css-1lkz3hi` | `分享此刻的想法...`，277,148 748×44，是纯 div，不可编辑 |
| 展开 | 标题 `TEXTAREA.css-1ta9b1n` | `placeholder="标题"`，277,148 560×28 |
| 展开 | 正文 `DIV.notranslate.public-DraftEditor-content` | `contenteditable=true`，277,176 |
| 展开 | 工具栏 `DIV.WritePinToolbar` | 277,388 748×32 |
| 展开 | 发布 `BUTTON.css-1m42xla` | 文本 `发布`，950,382 75×32 |

### 双份 DOM 的实证

点「分享此刻的想法...」展开后，页面里同时存在两份工具栏：

```
svg.ZDI--Image24 × 2
  [0] closest(button).getBoundingClientRect() → 0,0,0,0      ← 隐藏那份
  [1] closest(button).getBoundingClientRect() → 365,270,20,20 ← 可见那份
```

`querySelector` 返回 `[0]`，中心坐标 `(0,0)` → 真实鼠标点击落在页头 `HEADER.AppHeader`，页面上没有任何反馈（只在 analytics 里多了几条 fetch）。把过滤条件写成 `r.width>0 && r.height>0` 后立刻正常。

展开态工具栏 5 个按钮（y≈388）：

| x | 图标 class | 作用 |
|---|---|---|
| 277 | `ZDI--Hash24` | 话题（插入 `#` + 弹联想面板） |
| 321 | `ZDI--EmoHappy24` | 表情 |
| 365 | `ZDI--Image24` | 图片（开上传弹窗） |
| 409 | `ZDI--VideoCamera24` | 视频 |
| 453 | `ZDI--Barchart24` | 投票 |

右侧：`任何人都可以评论`（下拉，693,389）、`同步到圈子`（847,389，选中后显示圈子名）、`发布`（950,382）。

## 上传图片

页面里只有 1 个 `input[type=file]`：accept `image/webp,image/jpg,image/jpeg,image/png,image/avif,image/heic,image/heif,.avif,.heic,.heif,image/gif`，multiple，视觉 `0x0`。

**直接 `DOM.setFileInputFiles` 无效**：`files.length` 从 0 变 1，但没有上传请求、没有缩略图，编辑器毫无变化。

正确链路：

1. 点 `svg.ZDI--Image24` 的按钮 → 弹出 modal：顶部 tab `上传图片` / `公共图片库`（公共图片库右上有个红点），中间两个方块 `本地图片上传`（618,359）和 `手机扫码上传`（833,359），右上角 `×`。
2. 点 `本地图片上传` → 触发原生文件选择框（这一步才需要 `Page.setInterceptFileChooserDialog`）。
3. `DOM.setFileInputFiles({backendNodeId, files})` 后，弹窗底部出现缩略图 + `1/18（最多上传 18 张图片）` + `已上传 1 张图片，拖动可调整顺序`，右下角 `插入图片` 变为可点（1030,593，86×38）。
4. 点 `插入图片` → 弹窗关闭，编辑器里出现 `DIV.ImageArea`（261,214 760×118）内含 `DraggableTags-tag`（94×94 缩略图）+ 虚线 `+` 方块。

注意：这一步之后页面里 `input[type=file]` 的 `files.length` 仍是 `0`（走 `backendNodeId` 塞的那个 input 不在 `document.querySelectorAll` 里），**别拿它判断成败**；看缩略图、`1/18`、`插入图片` 是否可点。

## 话题联想面板

点 `#` 按钮会在光标处插入一个 `#`（Draft 里是独立 span），同时弹出 `DIV.TopicSuggestion-Popover.Popover-content`（591,145 379×320）。

行结构：

```html
<div class="Menu-item is-active" role="option">
  <div class="TopicSuggestion-TopicItem">
    <div class="text"><span class="topic-name">#字幕</span></div>
    <span class="new-topic">创建新话题</span>   <!-- 仅当话题不存在 -->
  </div>
</div>
```

每行 40px 高，`Menu-item` 宽 379。选中后正文里变成：

```html
<a class="zed-topic" target="_blank" rel="noopener noreferrer" data-topic-id="1434">#字幕</a>
```

实测词表（2026-09-15）：

- 输 `字幕` → `#字幕` 8.6万 / `#字幕翻译` 13.3万 / `#字幕制作` 1.8万 / `#电影字幕` 1.9万 / `#视频字幕` 1.7万 / `#字幕压制` 3920 / `#字幕设计` 2628 / `#英语字幕` 2639
- 输 `字幕制作` → `#字幕制作` 1.8万 / `#Arctime（字幕制作软件）` / `#场辞（字幕制作软件）` / `#33字幕` …
- 输 `视频字幕` → `#视频字幕` 1.7万 / `#音视频字幕校对` / `#提取视频字幕` / `#视频字幕翻译校对` …
- 输 `双语字幕` → **`#双语字幕` 带 `创建新话题`**（知乎没有），后面才是 `#中日双语字幕` / `#中韩双语字幕` / `#中英双语字幕` 35讨论 / `#双语字幕合成软件` …

坑：点带 `创建新话题` 的那一行，只会插入纯文本 `#双语字幕`（不是 `a.zed-topic`），`topic id` 为空。删它得用真实 Backspace（见下）。

## 圈子面板

点 `同步到圈子` → `选择圈子` 面板（约 860,374 起）：

- 标题 `选择圈子`；右上 `仅圈子可见` 开关（默认关）。
- 搜索框 placeholder `查找更多圈子`（897,408 220×24）。
- 每行：`DIV.css-zkfaav`（名字 + `未加入`）+ `DIV.css-2zu1e2`（圈子名）+ `DIV.css-dr5tlt`（`未加入`）+ `DIV.css-185m2h5`（`选择`，48×26，x≈1086）。
- 推荐列表里字幕相关的前三条：`字幕组翻译前线`（y≈478）、`字幕匠人`（y≈538）、`电影字幕学外语`（y≈598），其后是与内容无关的通用圈子（生物、美股、三体…）。列表底部 `没有更多了`。
- 选中后工具栏 `同步到圈子` 变为蓝色圈子名。发布后的想法上挂 chip：`https://www.zhihu.com/ring/host/2017193820442371609`（字幕组翻译前线，简介「专注于字幕翻译与制作的技术交流平台」）。

## 发布与结果

- 点 `发布`（950,382）→ 弹层：`发布成功` + `感谢你的第 10 篇创作！` + `查看详情`，下面私信分享（推荐用户）+ `更多分享`：复制链接 / 生成分享图 / 微信 / QQ。
- 内容管理 `https://www.zhihu.com/creator/manage/creation/all`：`共 10 条内容`，第一条 `想法` 标签 + `发布于刚刚` + 正文（含 `#话题`）+ 缩略图 + `1 被浏览 0 赞同 0 喜欢 0 评论 0 转发` + `编辑 / 数据 / 查看评论 / 分享 / 删除`。
- 页面里能拿到的 id 链接（一次去重即可）：

  ```
  https://www.zhihu.com/pin/2083102828277638313
  https://www.zhihu.com/creator/analytics/work/pin/2083102828277638313
  https://www.zhihu.com/creator/manage/comment/single/pin/2083102828277638313
  ```

- 公开页 `https://www.zhihu.com/pin/<id>` 正常展示：作者、标题、正文 + `#话题`、卡片图、`发布于 2026-09-15 08:05 · IP 属地湖南`、圈子 chip `字幕组翻译前线`，底部赞同/评论/收藏/喜欢/分享。

## 编辑器收起与恢复

点空白处或按 Escape 会让编辑器收起回占位态（`分享此刻的想法...` 重新出现）。**内容不丢**：再次点击占位文案，标题、正文、图片、话题全部恢复（`草稿 41 · 草稿保存中/已保存` 一直在跑，首页右上角还有 `草稿箱(N)`）。所以「误收起」不用重做，重开即可。

补充：收起态也有自己的工具栏（`#` / 表情 / 图片 / 视频 / 投票 + `发想法`）。**点收起态的「图片」图标会同时展开编辑器并打开上传弹窗**，不必先展开。另外两个状态里可见/隐藏那份 DOM 的先后顺序会互换（实测收起态可见的 `svg.ZDI--Image24` 是 `[0]`、展开态是 `[1]`），再次说明：**永远按可见性过滤，不要按索引取**。

## 状态校验片段（可直接用 cdp-eval）

```js
JSON.stringify((() => {
  const ed = [...document.querySelectorAll(".public-DraftEditor-content[contenteditable=true]")]
    .find(e => e.getBoundingClientRect().width > 0);
  const t = document.querySelector('textarea[placeholder="标题"]');
  return {
    title: t && t.value,
    text: ed && ed.innerText,
    topics: ed ? [...ed.querySelectorAll("a.zed-topic")].map(a => a.textContent + "|" + a.getAttribute("data-topic-id")) : [],
    imgs: document.querySelectorAll(".ImageArea img").length,
  };
})())
```
