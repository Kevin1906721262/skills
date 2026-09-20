# 微博视频发布页 实测 DOM 记录

2026-09-18 实测（Chrome 152 / macOS），账号：奉钦_（uid `6409507409`）。
URL：`https://weibo.com/upload/channel`。

> 页面是普通 DOM（**不是** shadow root），`cdp-eval` / `cdp-click` / `cdp-keys` 都能直接用。
> 但 class 名带构建哈希，**哈希会变**，选择器一律模糊匹配。

## 入口

| URL | 结果 |
|---|---|
| `https://weibo.com/upload/channel` | ✅ 视频发布页（页签「视频发布」） |
| `https://weibo.com/upload/uploadVideo` | ❌ 302 到 `/upload`，渲染成一个陌生人的个人主页 |
| `https://weibo.com/upload/video` | ❌ 同上 |

## 未上传时的「隐藏表单」

视频没上传前，整个表单已经在 DOM 里，但**全部 `offsetParent === null`**：

```
INPUT[radio].woo-radio-input ×2        原创 / 二创
INPUT[text]  placeholder="填写标题（0～30个字）"
INPUT[checkbox].woo-switch-input ×4    合集 / 关联原视频 / 允许他人划重点 / 允许他人剪辑
TEXTAREA._input_1rz8r_8                placeholder="有什么新鲜事想分享给大家？"
INPUT[file]._file_hqmwy_20             accept="image/*, .jpg, ..., video/mp4,video/x-m4v,video/*,.mkv,.flv" multiple
```

所以**不能**用"查得到这个字段"判断表单出来了 —— 要么看 `offsetParent`，要么看页面文案里有没有 `上传完成`。

## 上传：直接塞 input 无效

```
node ~/.agents/skills/bilibili-publish/scripts/set-file-input.mjs --selector 'input[type=file]' --index 0
→ ok:true, filesBefore:0, filesAfter:0
→ 页面文案仍是 "上传视频 | 发布≥1080p且时长≥1分钟… | 拖拽视频到此处也可上传 | 上传视频"
→ 没有上传请求，video.duration 仍是 null
```

换「真实点击 → 拦 fileChooserOpened → setFileInputFiles(backendNodeId)」立刻生效：

```

⚠️ 这个页面里的 `<video>` 是**空壳模板**（`src` 为空、`duration null`、`videoWidth 0`、`offsetParent null`），上传成功后也不会被填 —— **别拿它当判据**（首页发布框那条路也一样）。判据只有：文案 `上传完成` + 表单可见（`input[placeholder^="填写标题"].offsetParent` 非空）+ 封面帧出现（实测 9 帧）。
clicked: {x:720, y:334.5, w:142, h:34, t:"上传视频"}   backendNodeId: 5119
→ "上传完成 | 3.66MB/ 3.66MB | 上传字幕 删除 | 类型* | 原创 | 二创 | 内容声明* | 请进行内容声明（必填） |
   标题 | 0/30 | 上传封面 | 裁剪封面 | … | 分类 | 请选择合适的频道 | 合集 | 关联原视频 | 划重点 |
   设置 | 允许他人划重点 | 允许他人剪辑 | 设置微博内容 | 表情 | 话题 | 地点 | 公开 | 发布"
```

⚠️ 同一个浏览器里，**首页发布框**（`https://weibo.com/` 顶部）的 `input[type=file]` 直接 `setFileInputFiles` 是**有效**的（视频会以缩略图形式进入发布框，`请进行内容声明（必填）` 随之出现）。所以"直接塞不管用"是**页面级**特性。

## 类型 / 内容声明

类型：

```html
<label class="woo-radio-main _label3_1vpmt_32"><input type="radio" class="woo-radio-input">
  <span class="woo-radio-shadow"></span><span class="woo-radio-text">原创</span></label>
```
`cdp-click` 点 `label`（最小可点元素，实测 47×19）有效；回读 `input.checked`。

内容声明 —— **假 checkbox，真实鼠标点不动**：

```html
<div class="_panel_nsgmr_114">
  <div class="_sectionTitle_nsgmr_124"> 必选 </div>
  <button type="button" class="_option_nsgmr_213">
    <span class="_check_nsgmr_237"><!----></span>
    <span class="_optionLabel_nsgmr_265">我的内容无需声明</span>
  </button>
  … 5 个同类 button …
  <div class="_footer_nsgmr_270"><button class="woo-button…">确定</button></div>
</div>
```

- `cdp-click` 连点两次（坐标 x=529,y=335，正好在 button 上）→ 六个 `_check_*` 全是 `<!---->`，**没勾上**；
- `document.querySelectorAll("button[class*=option]")[0].click()` → 立刻变成 `<span class="_checkMark_nsgmr_256"></span>`（**这就是判据**）；
- 再点面板底部「确定」→ 面板收起，触发区文本变成 `我的内容无需声明`。

6 个选项原文：`我的内容无需声明` / `内容为转载` / `含AI生成内容` / `含虚构演绎内容` / `个人观点，仅供参考` / `内容含营销信息`。

## 标题 / 正文

- 标题：`input[placeholder^="填写标题"]`（maxLength 实际限 30，右侧计数器如 `6/30`）。
- 正文：`textarea._input_1rz8r_8`（与首页发布框同一组件）。
- 两个都用 `cdp-keys.mjs` 的 `CDP_FIND` + `CDP_TEXT` 写，写完全文回读。用 `Input.insertText` 写进去的 `效率工具分享` 计数器直接变 `6/30`，没有小红书那种"吞字符/多尾字"的问题。

## 封面：默认选中的是 0s 白帧

封面对话区：

```html
<div class="_a5rt_1gx9k_237">
  <div class="_a5list_1gx9k_304">
    <button class="_angle_1gx9k_308 _lt_1gx9k_121">…    ← 左箭头
    <div class="_a5listin_1gx9k_334">
      <div class="woo-box-flex _a5itembox_1gx9k_337">
        <div class="woo-picture-main woo-picture-hover _a5item_1gx9k_337 _a5itemcurr_1gx9k_367">  ← 当前选中
        …
```

- 帧缩略图：`document.querySelectorAll("div.woo-picture-main[class*=a5item]")`，**数组顺序 = 帧顺序**；
- 当前选中项多一个 `_a5itemcurr_*`；主预览 `<img>` 的 `src` 会跟着换；
- `_a5itemcurr` 的下标 + 预览 `src` 变了 —— 两处一起回读才算换成功。

实测 32.49s 的视频给了 9 帧，**第 i 帧 ≈ i×4 秒**（用 ffmpeg 抽 0/4/8/12/24/32s 帧逐张比对确认：c1↔4s、c3↔12s、c6↔24s、c8↔32s 内容完全一致）。

| 帧 | 内容 |
|---|---|
| 0 | 纯白（淡入帧）—— **默认就选它** |
| 1 / 2 | 标题「我们应该在IDEA中做些什么?」+ 右侧面板 + 底部字幕 |
| 3 / 4 / 5 / 6 / 7 | 同上，字幕不同；6 最完整 |
| 8 | 与 32s 同 |

帧图 URL 形态：`https://wx{1..4}.sinaimg.cn/large/006ZLDFLly1ih7qu8xxxxj31hc0u0yyyy.jpg`（1920×1080）。
想先看再挑：`ffmpeg -ss <t> -i video.mp4 -frames:v 1 out.jpg`。

## 其余字段（默认即可）

`分类` 标题是 `<div class="_tit1_hqe7u_152"> 分类 </div>`，**没有 `*`，非必填**（"请选择合适的频道"只是 placeholder）。
`合集`、`关联原视频`、`划重点`、`设置 → 允许他人划重点 / 允许他人剪辑` 默认全关。
正文工具栏：`表情 / 话题 / 地点 / 公开`，`公开` 是可见性（默认公开）。

## 发布与验证

发布按钮：`<button class="woo-button-main woo-button-flat woo-button-primary …">发布</button>`（在页面最底部，实测 y≈1168，要滚动；`cdp-click` 会自己 `scrollIntoView`）。

点完页面文案立刻变成：

```
视频发布 | 视频已上传成功，将在转码后发布，发布进度请查看视频管理> 请留意来自 @微博视频 的私信通知 | 再发一条视频
```

**这只是提交成功。** 实测约 20~30 秒后个人主页才出现：

```
奉钦_ | 刚刚 | 来自 微博视频号 | 1 阅读 | 推广 | 效率工具分享 奉钦_的微博视频 | 00:32 | 转发 评论 赞
```

并且 `全部微博（8）` → `全部微博（9）`。

取 uid（用来拼个人主页地址，别去猜）：

```js
window.$CONFIG.uid   // → 6409507409
```

## 附：首页发布框（无标题那一路）

`https://weibo.com/`，工具栏图标文本：`表情 / 图片 / 视频 / 话题 / 头条文章 / 更多`，右侧 `公开 ▾` + 「发送」。

- file input：`input[type=file]._file_hqmwy_20`，`accept` 含图片和视频，直接 `setFileInputFiles` 有效；
- 上传后发布框里出现一张缩略图（`div._picbed_1syq3_2`），旁边是「添加」磁贴；
- 同时出现必填项：`请进行内容声明（必填）`（`div._selfDeclaration_vkpry_10` 下，与视频发布页同一组件、同样要 `el.click()`）；
- 视频图标此时是 disabled 状态（`_disabled_2z30i_76`）——一条微博只挂一个视频；
- **没有标题字段**，正文即全部文字。
