# DOM 细节与常见卡点（2026-09 实测）

页面结构随小红书前端版本变化，这里的值用于出问题时定位，不要当成硬约束。

## 发布页入口与 tab

- 入口：`https://creator.xiaohongshu.com/publish/publish?source=official&from=menu&target=image`
  （`target=image` 对应「上传图文」；默认停在 上传视频 时需要手动点 tab）。
- 顶部 tab：`上传视频 / 上传图文 / 写长文 / 发播客`，DOM 都是 `div.creator-tab`（当前项多一个 `active`），文本在 `span.title`。
- 右上 `草稿箱(N)`：别动，用户可能有未完成的草稿。
- 上传区里 `.image-upload-buttons` 内有两个 `<button>`：`上传图片`、`文字配图`。

## 文字配图（写文字）

- 编辑器：`div.tiptap.ProseMirror[contenteditable=true]`，约 220×408。空态占位文案「真诚分享经验或资讯，提个问题也不错」。
- 注入文案：`el.focus()` → Range 收拢到末尾 → `document.execCommand("insertText", false, 文案)`，返回 `true` 且 `el.innerText` 即文案。用 input 事件或直接改 innerText 不可靠。
- 卡片实时预览，回车换行会改变卡片排版（可用于把长句拆成两行更好看）；不改文案本身的话保持原样即可。
- `生成图片`：空文案时禁用（淡色），有文案后变为可点。点击后卡片中央出现「图片生成中」，整页变为不可交互约 3~8s。
- 左下角会显示「自动保存于 HH:MM」。

## 预览图片页

- 点 `生成图片` 后进入。左上角标题变「预览图片」，左上是「← 返回」。
- 右侧「选择一个喜欢的卡片」网格：基础（含「换配色」）/ 插图 / 涂写 / 涂鸦 / 边框 / 手写 等。选中项有红框。
- 左下 `下一步` 是 `div/span`，文本精确 `下一步`。

## 发布表单页

- 图片区：`图片编辑 1/18`（1 是当前图，18 是上限），缩略图旁有 `编辑` 按钮和 `获取封面建议`。
- 标题：`input.d-text[placeholder="填写标题会有更多赞哦"]`，右侧计数 `n / 20`。React 受控，必须用原生 value setter + `input` 事件。
- 正文：另一个 `div.tiptap.ProseMirror[contenteditable=true]`，**已自动填入卡片文案**，计数 `n/1000`。
- 底部工具条：`# 话题` / `@ 用户` / `表情`（`button.contentBtn*`），以及推荐话题气泡（#生活美学 等）。
- 右侧有手机预览（笔记预览 / 封面预览 切换），可用来核对最终效果。
- 定时发布开关在正文下方。

## 底部固定栏（关键坑）

- 宿主自定义元素：`XHS-PUBLISH-BTN`，`getBoundingClientRect()` ≈ `{x:338,y:579,w:680,h:90}`，`element.shadowRoot === null`（**closed shadow root**）。
- 内部两个真实按钮（只能通过 CDP 穿透看到）：
  | 文本 | tag | class | 约坐标(1440×669 视口) |
  |---|---|---|---|
  | 暂存离开 | BUTTON | `ce-btn white` | 中心 (606, 624)，120×40 |
  | 发布 | BUTTON | `ce-btn bg-red` | 中心 (750, 624)，120×40 |
- 症状对照：`[...document.querySelectorAll('*')].filter(x=>x.textContent.trim()==='发布')` 返回 `[]`，`document.elementFromPoint(x,y)` 只返回 `XHS-PUBLISH-BTN` → 就是 closed shadow root，用 `scripts/xhs-el.mjs`。
- `DOM.getDocument({depth:-1, pierce:true})` 能拿到 closed shadow root 内部节点；但 **nodeId 是会话级的**，`DOM.getBoxModel`/`Input.*` 必须在同一脚本同一连接里完成，另开一次连接会报 `Could not find node with given id`。

## 发布结果

- 成功：整页显示对勾插画 + 「发布成功」+ 「3 秒后将返回发布页」+ 「立即返回」按钮；约 3s 后回到发布页（默认 上传视频 tab）。
- 核对：侧栏 `笔记管理` → 列表顶部出现新笔记，卡片显示标题、`2026-09-14 07:37` 形式的时间、状态标签 `审核中`，右侧是 浏览/评论/点赞/收藏/分享 计数。
- 笔记管理页顶部筛选：`全部 N / 已发布 / 审核中 / 未通过`，右上角有搜索框。

## 环境备忘

- 本机 `~/.codex/skills` 目前只有 `.system`，并没有指到 `~/.agents/skills` 的软链接；skill 是从 `~/.agents/skills` 被扫描到的。装新 skill 一律放 `~/.agents/skills/`。
