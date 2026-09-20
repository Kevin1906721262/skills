# DOM 细节与实测记录（2026-09-17 实测）

B站创作中心前端会改版，这里的值用于出问题时定位，不要当成硬约束。

本次实测环境：Chrome 152 / macOS，登录态为「成为UP主的第 505 天」，稿件数 5。
被测稿件：`任务管理2-封面音乐版-双语字幕版.mp4`，1920×1080 h264+aac，32.49s，3.8MB。

## 入口与上传页

`https://member.bilibili.com/platform/upload/video/frame?page_from=creative_home_top_upload`

顶部有 5 个 tab：`视频投稿 / 短剧投稿 / 专栏投稿 / UP动画 / 互动视频投稿`，默认停在 `视频投稿`。
页面三块提示：视频大小（≤16G、时长 ≤10h、粉丝≥1000 解锁 64G）、视频格式（MP4/MOV/MKV）、视频分辨率（1080P/4K）。
中间是大片虚线框「点击上传或将视频拖拽到此区域」，下面蓝色按钮 `上传视频`。

### 上传页的 `input[type=file]`

| index | accept | 备注 |
|---|---|---|
| 0 | `.mp4,.flv,.avi,.wmv,.mov,.webm,.mpeg4,.ts,.mpg,.rm,.rmvb,.mkv,.m4v,.vob,.swf,.3gp,.mts,.m2v,.m2ts,.f4v,.m2t,.3g2,.asf` | `multiple`，`style="display:none"`，**塞这个** |
| 1 | 同上 | `name="buploader"`，尺寸 0 |
| 2 | `.txt` | 字幕/其他文本 |

`set-file-input.mjs --index 0` 返回 `filesBefore:0 / filesAfter:1`，页面 head 变成
`… 投稿 | … | 发布视频 | 批量操作 | bili_task2 | 上传完成 | 添加`。

### 表单页的 `input[type=file]`（索引会变！）

| index | accept | 用途 |
|---|---|---|
| 0 | 视频后缀串 | 视频（隐藏，值 `C:\fakepath\bili_task2.mp4`） |
| 1 | `image/png, image/jpeg` | **封面制作弹窗里的上传封面** |
| 2 | 视频后缀串 | `name="buploader"`，可见 |
| 3 | `.txt` | |
| 4 | `.zip` | |

## 发布视频表单

上传完成后整页变成「发布视频」：上方是稿件卡片（`添加视频` / `+添加分P` / 文件行 + `更换视频`），
下面依次是 `基本设置`（含 `一键填写` 按钮）、`标题`、`创作声明`、`分区`、`标签`、`简介`、`定时发布`、`加入合集`、`商业推广`、`更多设置`，最底部 `存草稿` / `立即投稿`。

| 用途 | 选择器 | 备注 |
|---|---|---|
| 标题 | `input.input-val[placeholder="请输入稿件标题"]` | 默认值 = **文件名**（`bili_task2`），上限 80，计数 `33/80`，Vue 受控 |
| 创作声明 | `input.bcc-select-input-inner` | 默认 `内容无需标注`，placeholder `请选择符合您视频内容的创作声明` |
| 分区 | `div.form-item` / `div.video-human-type`，行文本 `* 分区 人工智能` | **平台自动猜**：初读是 `科技数码`，改完标题变成 `人工智能` |
| 标签输入 | `input.input-val[placeholder="按回车键Enter创建标签"]` | 上限 10 |
| 标签 chip | `div.label-item-v2-container` → `p.label-item-v2-content` + `svg.close` | 平台默认预置 `学习 / 生活记录 / 记录` |
| 简介 | `div.desc-text-wrp div.ql-editor` | Quill，上限 2000；`.fans-input-wrp div.ql-editor` 是**另一个隐藏编辑器** |
| 底部按钮 | 文本 `存草稿` / `立即投稿` | 立即投稿蓝底 120×40 |

### 标签的两个坑（实测）

1. **JS 派发的 click 删不掉 chip。** `svg.close.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true,view:window}))` 对 3 个 chip 都执行了，回读 chip 数组**一个都没少**。改成 `cdp-click` 真实鼠标点 `svg.close`（9×9）后正常删除（而且一次点击后 chip 从 3 个变成 1 个 —— 删完**务必回读**再删下一个）。
2. **加标签要「逐字符按键」+「单独一次 Enter」，分两次调用**：`CDP_TYPE='任务管理'` 之后输入框 value 变成 `任务管理`，再用 `CDP_KEYS='Enter'` 才生成 chip、输入框清空。
   同一批里 `程序员` 失败：value 正确变成 `程序员`，按 Enter 后输入框被清空、chip 没增加 —— 平台拒绝了这个词。通过的有：`任务管理 / 效率工具 / IDEA / AI / 编程 / 教程`。

### 简介写入（`cdp-keys` 一次搞定）

```bash
CDP_WS="$WS" CDP_SEL_END='.desc-text-wrp div.ql-editor' CDP_TEXT="$(cat /tmp/bili_desc.txt)" \
  node ~/.agents/skills/chrome-cdp-drive/scripts/cdp-keys.mjs
```

返回 `selEnd: "ok:1"`、`after.cls = "ql-editor"`、`after.text` 为全文、计数 `154/2000`。
DOM 结果：7 个 `<p>`（6 行正文 + 1 个 `<p><br></p>` 空行）。`innerText` 里看到的双换行是块级元素分隔，不是写脏了。

## 封面制作弹窗

入口：`div.cover-empty-pill`（文本「添加封面」，82×25）→ `.cover-editor.bcc-dialog__wrap`（滚动容器 `scrollHeight 895 / clientHeight 669`）。

左栏 `.cover-editor-content-left`（106,93,360,768）：竖排 tab `智能 / 模版 / 文字 / 贴纸 / 滤镜`。

- `.ai-generate-bar`（「智能生成封面」+ AI 角标）
- `.ai-cover-list.list.container`（166,149,300,235），里面 `.card` 有 4 张：`card-clear`（「不使用」，默认选中）+ 3 张视频截图，背景是 `blob:https://member.bilibili.com/...`（**拿不到原始 URL，curl 下不来**）

中栏是**两块 fabric 画布**：

| 画布 | 容器类 | canvas 元素 rect |
|---|---|---|
| 首页推荐封面（4:3） | `div.cover-editor-panel-canvas-image.editor_4_3` | `516,199,420,236` |
| 个人空间封面（16:9） | `div.cover-editor-panel-canvas-image.editor_16_9` | `516,488,420,236` |

两块都是 `canvas.lower-canvas` + `canvas.upper-canvas` 一对，尺寸 `840×472`。
`document.querySelectorAll("canvas.lower-canvas")` 顺序即 **[4:3, 16:9]**。

### 双比例同步（关键）

勾选前后各统计一次橙色像素（`r>220 && 120<g<190 && b<60`，每 37 像素采样一点）：

| 状态 | 4:3 橙色像素 | 16:9 橙色像素 |
|---|---|---|
| 上传自定义图之后、未勾选 | 3052 | **0**（全白） |
| 勾上 `div.sync-checkbox-wrapper`（「双比例同步改动」）之后 | 3052 | **3052** |

勾选后 DOM 会加 `bcc-checkbox-checked`，并有 tooltip `--sync-tip-text: '勾选后2个比例的封面效果将自动保持同步'`。

上传自定义图的输入框在 `div.bcc-upload.cover-upload.cover-editor-panel-select-item`（466,724,162,74）里，`accept="image/png, image/jpeg"`。
最后点右下角 `完成`（90×40，蓝底，实测 CSS 坐标 x=1263,y=603 附近）写回表单；`取消` 在其左侧。

### 抽帧经验

```bash
ffmpeg -v error -ss 1.0 -i /tmp/up.mp4 -frames:v 1 -vf scale=900:-1 /tmp/f_a.png -y
```

- `n=0`（0.0s）：**纯白淡入帧**（PNG 只有 1.3KB）。
- `1.0s`：稳定的标题卡（灰底 + 右侧橙色面板 + 三行列表），适合做封面。
- `2.0s`：同一构图但第三行在动画中半透明 —— 别选。
- `2.6s` 之后：切进 IDE 录屏。
- B站自己给的 3 张推荐帧全是 IDE 录屏截图，没给标题卡。

## 投稿后

点「立即投稿」→ 页面出现 `稿件投递成功 / 现在加热让更多人第一时间看到～ / 立即加热 / 查看进度 / 再投一个`。

`https://member.bilibili.com/platform/upload-manager/article` 顶部计数：`全部稿件 6 / 进行中 1 / 已通过 5 / 未通过 0`，第一条即新稿件：

```
00:00:00  用 AI 给 IDEA 加了个任务管理面板，Ctrl+E 一键唤起
2026年09月17日 20:03:35   转码完成   审核中   查询进度 / 编辑
```

注意：**时长显示 `00:00:00`**（元数据滞后，老稿件都正常显示 `00:06:32` 等），别据此判断上传失败。
