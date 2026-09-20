---
name: bilibili-publish
description: 通过浏览器驱动 B站创作中心(member.bilibili.com)网页版投稿视频——上传视频文件、设封面(系统推荐帧/AI生成/自定义上传，含 4:3 与 16:9 双比例同步)、填标题/分区/标签/简介、立即投稿或存草稿，并在稿件管理页验证。当用户说「发个B站」「帮我投稿B站」「把这个视频发到B站/bilibili」「B站投稿」时使用。当前只覆盖**视频投稿**；不用于：图文/专栏/动态/番剧/互动视频投稿、管理已有稿件(改标题、删除、改权限)、B站私信评论；也不用于发抖音(douyin-publish)、小红书(xiaohongshu-publish)、快手(kuaishou-publish)、知乎(zhihu-publish)、闲鱼(xianyu-publish)。
---

# B站：投稿视频

把一个本地视频文件投成 B站稿件。全程用 Chrome CDP 驱动已登录的浏览器（环境搭建、取页签、点击/输入脚本见 skill **chrome-cdp-drive**）。

**只写视频投稿**。图文/专栏/动态/番剧/互动视频都在同一个投稿页的其他 tab 里，本 skill 不覆盖。

## 前置

- 浏览器必须带调试端口（`curl -s --max-time 2 http://127.0.0.1:9222/json/version` 有 JSON）。
- 入口：`https://member.bilibili.com/platform/upload/video/frame?page_from=creative_home_top_upload`。目标页签 URL 含 `member.bilibili.com/platform/upload`；没有就 `PUT /json/new` 打开。
- 稿件规格（页面上写死的）：**≤16G、时长 ≤10 小时**，推荐 MP4/MOV/MKV，推荐 1080P/4K。粉丝 ≥1000 才能解锁 64G 超大文件。
- **中文文件名先复制成 ASCII 路径**再操作，省掉转义和输入法问题：
  ```bash
  cp "/Users/你/Desktop/任务管理2-封面音乐版-双语字幕版.mp4" /tmp/up.mp4
  ```
- **发布是不可逆的外部动作。** 只在用户明确说「发/投稿」时才点「立即投稿」；用户只是要准备内容时，填完表单停下并告知。**用户没给标题/简介时先问**，别自己编。
- 投稿页左侧菜单里有「字幕管理」；本次流程不涉及字幕，需要给稿件配字幕时走那边。

## 标准流程

1. **上传视频** —— 落地页有 3 个 `input[type=file]`：`[0]` 视频（隐藏，`accept=".mp4,.flv,…,.mkv,…,` 一长串后缀`"`）、`[1]` 视频（`name="buploader"`）、`[2]` `.txt`。**只塞 `[0]`**：

   ```bash
   node ~/.agents/skills/bilibili-publish/scripts/set-file-input.mjs \
     --ws "$CDP_WS" --file /tmp/up.mp4 --index 0 --wait 6000
   ```

   判据是**页面从上传区切到「发布视频」表单**（出现 `基本设置` / `封面` / `标题` / `标签`），稿件卡片上出现「上传完成」绿色进度条。`filesAfter` 这次返回 1，但**别依赖它**——页面重渲染后索引会变。3.8MB/32s 的片子约 6 秒传完。

   ⚠️ 表单出现后 `input[type=file]` 的列表会变（实测变成 `[0]` 视频 / `[1]` 封面图 / `[2]` 视频 / `[3]` `.txt` / `[4]` `.zip`）。**后面设封面要用 `[1]`，不是 `[0]`。**

2. **标题** —— `input.input-val`（placeholder `请输入稿件标题`），**默认值是文件名**（本次是 `bili_task2`），必须改。上限 **80** 字，右侧计数器 `33/80`。Vue 受控，走原生 setter + `input`/`change`：

   ```js
   const el=[...document.querySelectorAll("input.input-val")].find(e=>e.placeholder.includes("稿件标题"));
   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,"标题文字");
   ["input","change","blur"].forEach(t=>el.dispatchEvent(new Event(t,{bubbles:true})));
   ```

   改完回读计数器和 value 确认没被框架回滚。

3. **创作声明** —— `input.bcc-select-input-inner`，默认 `内容无需标注`。用户没特别要求就别动（AI 生成内容才需要选对应的声明）。

4. **分区** —— **平台会自动猜**，必须在投稿前回读确认：本次上传时是 `科技数码`，改完标题后自己变成了 `人工智能`。读法：找 `div.form-item` 里文本匹配 `/^\* 分区 /` 的那个（类名 `video-human-type`）。用户指定了分区就点开下拉改，没指定就确认它是合理的再往下走。

5. **标签** —— ⚠️ 平台**默认塞 3 个跟内容完全无关的标签**（本次是 `学习 / 生活记录 / 记录`），**必须删掉**。
   - **删**：chip 是 `div.label-item-v2-container`，里面有 `p.label-item-v2-content`（名字）和 `svg.close`（删除）。**只能真实鼠标点 `svg.close`**——用 JS `dispatchEvent(new MouseEvent("click"))` 实测**不生效**。用 `cdp-click` + `CDP_FIND` 返回目标 chip 的 `svg.close`，一次删一个，删完回读 `document.querySelectorAll("div.label-item-v2-container p.label-item-v2-content")` 确认。
   - **加**：输入框是 `input.input-val`（placeholder `按回车键Enter创建标签`）。**分两次调用**：先 `cdp-keys` 用 `CDP_TYPE='任务管理'`（逐字符真实按键）输入，再单独一次 `CDP_KEYS='Enter'` 建 tag。一把 `CDP_TEXT` 插入不稳。
   - **被拒的表现**：按 Enter 后输入框被清空、但没生成 chip。实测 `程序员` 被 B站拒（`任务管理 / 效率工具 / IDEA / AI / 编程 / 教程` 都通过）。**被拒就换个词，别反复重试同一个词。**
   - 上限 10 个，行内会提示「还可以添加N个标签」；页面上还有一排「推荐标签」胶囊（人工智能/教程/IDEA/一键/任务/面板/AI/编程/计算机…）和「参与话题」（带「活动」角标），可以点推荐标签代替手输。

6. **简介** —— Quill 富文本，选择器 `div.desc-text-wrp div.ql-editor`。⚠️ 页面里**还有第二个 `.ql-editor` 藏在 `.fans-input-wrp` 下且不可见**，选择器必须限定 `.desc-text-wrp`，否则会写进隐藏的那个。上限 2000，计数器在行尾 `154/2000`。

   用 **chrome-cdp-drive** 的 `cdp-keys.mjs`，`CDP_SEL_END` 摆光标 + `CDP_TEXT` 注入（不要用 `cdp-type.mjs`，它会在元素中心点一下鼠标）：

   ```bash
   CDP_WS="$CDP_WS" CDP_SEL_END='.desc-text-wrp div.ql-editor' CDP_TEXT="$(cat /tmp/desc.txt)" \
     node ~/.agents/skills/chrome-cdp-drive/scripts/cdp-keys.mjs
   ```

   回读校验：`innerText` + 计数器。换行会各生成一个 `<p>`（`innerText` 里看着像多了一堆空行，那是块级元素的分隔，不是脏字符）；空行会变成 `<p><br></p>`。

7. **封面（必填，且有两个比例）** —— 见下面单独一节。跳过这步投不出去。

8. **投稿与验证** —— 表单底部是 `存草稿` 和 `立即投稿`（蓝底 120×40）。其余默认值本次实测可用、不用改：`定时发布` 关闭（=立即发布，最早 ≥5 分钟/最晚 ≤15 天）、`加入合集` 未开通（需权益等级 Lv2）、`商业推广` 不勾、`更多设置`（声明与权益/视频元素/互动管理）不动。

   点「立即投稿」后页面出现 **「稿件投递成功」+ `立即加热` / `查看进度` / `再投一个`**。那不是证据，**去稿件管理页确认**：

   ```
   https://member.bilibili.com/platform/upload-manager/article
   ```

   B站的列表**不是缓存的**（这点和抖音不一样），跳过去就能看到新稿件在**第一条**：标题、`2026年09月17日 20:03:35` 形式的投稿时间、状态 `转码完成` `审核中`。⚠️ **时长会先显示 `00:00:00`**，是元数据滞后，不是没传上去。

## 封面：自定义图 + 双比例

「系统推荐封面」那一排给了 4 张：1 张 `AI生成`（点了要等生成，可能很久）+ 3 帧从视频里抽的截图（`blob:` URL，**不能下载**，只能看）。推荐帧往往全是录屏截图，效果一般。

**更好的做法：把视频自带的标题/封面帧抽出来当自定义封面。** 先本地抽帧看：

```bash
ffmpeg -v error -ss 1.0 -i /tmp/up.mp4 -frames:v 1 /tmp/cover.png -y
```

⚠️ 视频 0s 常常是**淡入白帧**（本次就是），要往后抽：0s 是白的、1.0s 才是稳定的标题卡、2.0s 反而在动。抽 3~4 个时间点对比挑一张。

上传步骤：

1. 点封面的 `div.cover-empty-pill`（文本「添加封面」，82×25）→ 打开「封面制作」弹窗。
2. 弹窗布局：左=素材栏（智能/模版/文字/贴纸/滤镜 + 帧列表，每张 `100×76`）、中=**两块画布**「首页推荐封面（4:3）」和「个人空间封面（16:9）」、右=手机预览。
3. 塞自定义图：`div.bcc-upload.cover-upload` 里的 `input[type=file][accept="image/png, image/jpeg"]`。**在表单页它是全局 `input[type=file]` 的 `index 1`**（`index 0` 是视频）：
   ```bash
   node ~/.agents/skills/bilibili-publish/scripts/set-file-input.mjs \
     --ws "$CDP_WS" --file /tmp/cover.png --index 1 --wait 4000
   ```
4. ⚠️⚠️ **上传只进 4:3 那块画布，16:9 那块还是空的** —— 而弹窗顶部写着「两个比例的封面都会被展示给观众，请确认 4:3、16:9 比例下的封面效果」。**解法：勾上 `div.sync-checkbox-wrapper`（文本「双比例同步改动」）**，勾上后 16:9 立刻同步成 4:3 的内容。

   **验证同步成功**：两块都是 fabric `<canvas>`，`document.querySelectorAll("canvas.lower-canvas")` 返回 2 个（**4:3 在前，16:9 在后**）。统计各自的橙色像素数，两块相等才算成功（实测勾选前 `3052 / 0`，勾选后 `3052 / 3052`）。
5. 点弹窗右下角 `完成`（蓝底 90×40）写回表单，封面位出现缩略图。

## 出问题时

- **上传没反应**：确认 `--index 0`；表单页里 `[0]` 仍是视频、`[1]` 是封面图，别串。
- **「立即投稿」点不动/报错**：`* 封面` 是必填，先设封面。
- **封面只显示了 4:3**：16:9 没同步，回去勾「双比例同步改动」再点完成。
- **标签加不上**：多半是这个词被 B站拒了（输入框被清空就是拒了），换词。
- **分区不对**：分区是平台自动猜的，手动改，别信默认值。
- **投稿后管理页看不到**：先确认跳转到了 `upload-manager/article`；列表本身不缓存，看不到就是真没投出去。
- **出现验证码/安全验证**：截图让用户手动处理，不要自动解。
- 更细的选择器、坐标、实测记录见 [references/dom-notes.md](references/dom-notes.md)。

## 脚本

`scripts/set-file-input.mjs` —— 用 CDP DOM 域把本地文件塞进页面的 `input[type=file]`，`--index` 选第几个（和 skill **douyin-publish** 里的同名脚本是同一个工具，各带一份保持自包含）。

```bash
node .../set-file-input.mjs --ws "$CDP_WS" --file /abs/a.mp4 --index 0 [--selector "input[type=file]"] [--wait 6000]
```

其余步骤（标题、标签、简介、封面、投稿）用 **chrome-cdp-drive** 的 `cdp-eval` / `cdp-click` / `cdp-keys` 即可。
