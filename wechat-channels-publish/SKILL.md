---
name: wechat-channels-publish
description: 通过浏览器驱动微信视频号助手(channels.weixin.qq.com)网页版发表视频动态——上传视频、填视频描述与短标题、加 #话题、确认自动封面(个人主页卡片 3:4 / 分享卡片 4:3)、点发表并在视频管理页核对。当用户说「发个视频号」「把视频发到视频号」「微信视频号发表/投稿」「发条视频号动态」时使用。当前只覆盖**视频**；不用于：图文动态、音乐/音频、直播、管理已有视频(改描述封面/置顶/权限/删除)、后台数据；也不用于发公众号文章(wechat-mp-draft)、抖音(douyin-publish)、B站(bilibili-publish)、小红书(xiaohongshu-publish)、快手(kuaishou-publish)、知乎(zhihu-publish)、闲鱼(xianyu-publish)。
---

# 视频号：发表视频

把一个本地视频发成视频号动态。全程用 Chrome CDP 驱动已登录的浏览器（环境搭建、取页签、截图脚本见 skill **chrome-cdp-drive**）。

**只写视频**。图文/音乐/音频在左侧菜单的其他入口，本 skill 不覆盖。

## 前置

- 浏览器必须带调试端口（`curl -s --max-time 2 http://127.0.0.1:9222/json/version` 有 JSON）。
- 入口：`https://channels.weixin.qq.com/platform/post/create`（页签标题「视频号助手」；左侧「内容管理 → 视频」右上角「发表视频」也是这个页）。
- 视频规格（页面上写死的）：**≤8 小时、≤20GB、建议 720p 及以上、码率 ≤10Mbps、MP4/H.264**。
- **中文文件名先复制成 ASCII 路径**再操作，省掉转义和输入法问题：
  ```bash
  cp "/Users/你/Desktop/任务管理2-封面音乐版-双语字幕版.mp4" /tmp/up.mp4
  ```
- **发表是不可逆的外部动作。** 只在用户明确说「发/发表」时才点「发表」；用户只是要准备内容时，填完表单停下并告知。**用户没给文案时先问**，别自己编。

## ★ 核心坑：这页是「无界(wujie)微前端」，普通选择器一个都匹配不到

视频号助手的真实 DOM 挂在

```js
document.querySelector("wujie-app").shadowRoot   // 下面简称 APP
```

里。从 `document` 出发 `querySelectorAll("input")` 返回**空数组**，`cdp-eval` / `cdp-click` / `cdp-keys` 的 `CDP_SEL_*` 参数**全部失效**——但页面看起来一切正常，最容易被误判成"页面还没加载完"。

**先自检**（`hasShadow` 必须为 true，否则别再往下走）：

```bash
CDP_WS="$WS" CDP_EXPR='(()=>{const H=document.querySelector("wujie-app");const APP=(H&&H.shadowRoot)||document;return JSON.stringify({hasHost:!!H,hasShadow:!!(H&&H.shadowRoot),text:APP.querySelector("body").innerText.slice(0,200)})})()' \
  node ~/.agents/skills/chrome-cdp-drive/scripts/cdp-eval.mjs
```

本 skill 的两个脚本已经把这个包装好了，直接用它们，别自己拼 `CDP_SEL`：

- `scripts/shadow-el.mjs` —— 在 APP 里找元素 / 真实点击 / 真实输入（`--find` 里写 `APP.querySelector(...)`，`APP` 是预置好的）
- `scripts/upload-video.mjs` —— 把本地文件塞进 file input（走 `DOM.getDocument({pierce:true})` 穿透 shadow root）

### 两条必须记住的推论

1. **`document.activeElement` 拿不到影子里的焦点**：焦点在 shadow root 内时它返回的是宿主 `<wujie-app>`，**不能**用它判断"是不是聚焦到了输入框"。
2. **`Input.insertText` 打给"当前焦点"**，而焦点可能是上一次操作遗留的**另一个字段**。实测：没先 focus 就插短标题，文字**悄悄写进了视频描述**（命令没报错、短标题还是空）。所以：
   - `shadow-el.mjs` 在带 `--text/--type/--keys` 时会**自动 focus + 把光标收拢到该元素内容末尾**（`--all` 改全选）；
   - **写完必须回读那个字段的值**（脚本输出的 `after` / `el.value` / `el.text`），不要"命令跑完就当成了"。

## 标准流程

### 1. 上传视频

视频号只有一个视频 file input：`accept="video/mp4,video/x-m4v,video/*"`、带 `multiple`、`display:none`，**藏在 shadow root 里**（DOM 路径 `doc>shadow`）。

```bash
node ~/.agents/skills/wechat-channels-publish/scripts/upload-video.mjs \
  --ws "$WS" --file /tmp/up.mp4 --wait 6000
```

**判据是页面切到了表单**（head 里出现 `封面预览 / 个人主页卡片 / 分享卡片 / 视频描述 / 短标题 / 发表`），以及**脚本回读到的 `after.video` 和源文件对得上**：

```json
"after": { "video": { "duration": 32.491, "w": 1920, "h": 1080 }, "fileInputs": [0, 0] }
```

- `files.length` **永远是 0**（框架读完就清空 input），**别拿它当判据**。
- 上传后 file input 数量 **1 → 2**（多出来的是封面上传的），别按老索引乱塞。
- 3.8MB / 32s 的片子约 1~2 秒就传完；大文件把 `--wait` 加长，或者轮询上面那句自检。

### 2. 视频描述（= 观众看到的正文/标题）

富文本 contenteditable，选择器 **`div.input-editor`**（placeholder「添加描述」；下面还有 `#话题` / `@视频号` 两个插入按钮，要加话题 chip 就用 `--type` 打 `#关键词`）。

```bash
node ~/.agents/skills/wechat-channels-publish/scripts/shadow-el.mjs \
  --ws "$WS" --find 'APP.querySelector("div.input-editor")' --end --text '效率工具分享'
```

回读 `el.text` 应为全文。写完顺手截图看一眼手机预览卡片，文案会即时渲染上去。

要带话题就接着看下一节；话题和正文可以一次性写进去（`--text '正文 #话题A #话题B'`），**每个话题后面留空格**。

### 3. 加话题（`#话题`）

描述框下面两个按钮：`#话题`（`div.finder-tag-wrap.btn` > `div.tag-inner`，64×30）和 `@视频号`。**它们只做一件事——在光标处插入一个 `#` / `@`**，不弹面板。

#### 视频号没有话题联想面板

实测点 `#话题` 之后**不会**弹候选列表；同时开了 Network 域抓包，打字期间**没有任何 topic/subject/suggest 类的请求**（唯一一个 `search` 请求是 `collection/search_collection`，属于「添加到合集」）。所以这里不像抖音/小红书——**打了什么就是什么**，没有「先搜话题再选中」那一步。

#### 话题的边界是空白符

紧挨着 `#` 的连续文字会**整体**变成一个话题，平台自己把它包成：

```html
<span class="hl topic" data-type="topic">#任务管理</span> <span class="hl topic" data-type="topic">#效率工具</span> IDEA
```

| 输入 | 结果 |
|---|---|
| `#任务管理IDEA`（中间不空格） | 是**一个**话题 `#任务管理IDEA` ← 最常见的翻车点 |
| `#任务管理 IDEA` | 话题 `#任务管理` + 普通文字 `IDEA` |
| `#任务管理 #效率工具 IDEA` | 两个话题 + 一段普通文字 |

**所以每个话题后面必须补一个空格**（或标点/换行）再接着写别的字；一串话题之间也都用空格分隔。

#### 写法

`--text`（一次性 `Input.insertText`）和 `--type`（逐字符真实按键）**实测都能正确生成 `data-type="topic"`** —— 高亮是页面按内容算出来的，不吃输入事件。所以话题不用像抖音那样非得逐字符打，一次把整段文案写进去就行：

```bash
node ~/.agents/skills/wechat-channels-publish/scripts/shadow-el.mjs \
  --ws "$WS" --find 'APP.querySelector("div.input-editor")' --end \
  --text '效率工具分享 #任务管理 #效率工具 #IDEA'
```

**但要按顺序做**：如果描述正文已经写好了、只想单独补一串话题，第二次调用**必须带 `--end`**（脚本会自动 focus 并把光标收拢到末尾）。不带的话 `Input.insertText` 会打给上一次遗留的焦点，写进别的字段——正文里那段「静默失败」就是同一个坑。

#### 回读校验（看 span，不看文字）

光看 `innerText` 分不出「真话题」和「普通井号文字」，要数 `data-type="topic"`：

```bash
CDP_WS="$WS" CDP_EXPR='(()=>{const e=document.querySelector("wujie-app").shadowRoot.querySelector("div.input-editor");
  return JSON.stringify({text:e.innerText, topics:[...e.querySelectorAll("[data-type=topic]")].map(t=>t.innerText)})})()' \
  node ~/.agents/skills/chrome-cdp-drive/scripts/cdp-eval.mjs
```

返回 `topics: ["#任务管理","#效率工具","#IDEA"]` 才算对。**要删掉某个话题**：把光标收到它后面按 Backspace 逐字删（`shadow-el.mjs --end --keys 'Backspace,Backspace,...'`），或者 `--all --keys Backspace` 整段重写。

`@视频号` 同理，只插入一个 `@`，后面接账号名（账号联想面板本次未实测）。

### 4. 短标题（可选，但值得填）

`input.weui-desktop-form__input`，placeholder `填写短标题有机会获得更多流量`。页面 tooltip 原文：**「短标题会出现在公众号、发现页等地方，展示给其他人。」** 所以用户给的"标题"这句话，**描述和短标题两处都填上是合适的**（本次实走两处填了同一句「效率工具分享」）。

```bash
node ~/.agents/skills/wechat-channels-publish/scripts/shadow-el.mjs \
  --ws "$WS" --find 'APP.querySelector("input[placeholder*=短标题]")' --text '效率工具分享'
```

实测 6 个字（`效率工具分享`）可以正常提交；平台口径是 6~16 字，但**只验证过 6 字这一档**，写更长的先看页面有没有报错。

### 5. 其余字段：默认值就能用，别乱动

本次实走**全部保持默认**，直接发表成功：

| 字段 | 默认 | 说明 |
|---|---|---|
| 位置 | 账号/网络推的城市（两次实测分别给到 `长沙市`、`杭州市`） | 平台自带，不用管 |
| 添加到合集 | 未选 | 要加才点 |
| 链接 | 未选 | |
| 活动 | `不参与活动` | |
| 定时发表 | `不定时`（= 立即发表） | 要定时才切「定时」 |
| 声明原创 | 复选框**未勾**，文案「声明后，作品将展示原创标记，有机会获得广告收入。」 | 用户没要求就别勾 |
| 视频标注 | 未选 | |

### 6. 封面：平台自动生成两个比例，默认可以直接用

上传完成后右上出现「封面预览」，两张卡片各自带一个 `编辑`：

- **个人主页卡片 3:4** —— `.vertical-img-wrap .edit-btn`（74×98 的卡）
- **分享卡片 4:3** —— `.horizon-img-wrap .edit-btn`（128×98 的卡）

默认封面是平台从视频里自动抽的帧。**实测这次抽到的是视频里的标题卡正片，两张卡都可用，不需要手工做**（对比 B站：那边必须手工设封面，否则投不出去；视频号没这个要求）。

要改再点 `编辑`，弹窗（本次实测「编辑个人主页卡片」）里有：上方裁剪框（含 `平铺展示` 按钮）、下方 `从视频中选择封面` 时间轴 + `上传封面` 加号、右侧 `效果预览`，右上角 ✕ 关闭。

### 7. 发表与验证

底部三个按钮：`保存草稿` / `手机预览` / **`发表`**（橙色 primary，120×40）。上传没完成时 `发表` 是 `weui-desktop-btn_disabled`，**点之前先确认它不再带 disabled**：

```js
[...APP.querySelectorAll("button")].filter(b=>b.getBoundingClientRect().width>0)
  .map(b=>({t:b.innerText.trim(), disabled:!!b.disabled||/disabled/.test(b.className)}))
```

点发表（用 `shadow-el.mjs --click`，`APP.querySelector` 里挑文本为「发表」且宽高 > 0 的那个）：

```bash
node ~/.agents/skills/wechat-channels-publish/scripts/shadow-el.mjs \
  --ws "$WS" --click \
  --find '[...APP.querySelectorAll("button")].find(b=>b.innerText.trim()==="发表"&&b.getBoundingClientRect().width>0)'
```

表现：按钮变成转圈状态，约 5 秒后**自动跳转到 `https://channels.weixin.qq.com/platform/post/list`**（视频管理）。

**"跳转了"不是证据，去列表里读第一条**：

```bash
CDP_WS="$WS" CDP_EXPR='(()=>{const APP=document.querySelector("wujie-app").shadowRoot;return APP.querySelector("body").innerText.replace(/\n+/g," | ").slice(0,400)})()' \
  node ~/.agents/skills/chrome-cdp-drive/scripts/cdp-eval.mjs
```

成功的形态（`视频管理 | 特效创作工具 | 视频 (13) | 合集 (0) | … | 发表视频 | 效率工具分享 | 2026年09月18日 12:23 | 0 | 0 | 0 | 0 | 0 | 置顶 | 分享 | 评论管理 | 修改描述和封面 | 可见权限 | 删除 | …`）：

- 新视频在**第一条**，标题 = 你填的描述，右边是发表时间，再往右是 5 个计数（播放/点赞/评论/转发/推荐）。
- 计数全是 0 是正常的（刚发）；列表里**没有「审核中」这类状态列**，不要去找。
- 列表**不缓存**，跳过去看到的就是真实状态；看不到就是真没发出去。

## 出问题时

- **`querySelectorAll("input")` 返回空**：这就是 shadow root 的坑，用 `APP` 前缀或本 skill 的脚本，别怀疑页面没加载。
- **文案写进了别的字段**：`Input.insertText` 打给了上一次的焦点。带 `--end` 重写，写完回读。
- **话题不对**：`#` 后面紧挨着的字会**整体**并成一个话题（`#任务管理IDEA`）。话题之间、话题与正文之间都要留空格，然后数 `[data-type=topic]` 回读。
- **找不到话题候选列表**：本来就没有。视频号不提供话题联想，自己打词即可。
- **上传没反应**：确认用的是 `upload-video.mjs`（不是 bilibili/douyin 那份 `set-file-input.mjs`，那份穿不进 shadow root）。
- **「发表」点不动**：先看它是不是还带 `disabled`（视频没传完）；再确认视频描述不为空。
- **发表后没跳转**：等 5~10 秒再看一次 URL，别连点（连点可能重复发表）。
- **出现滑块/安全验证**：截图让用户手动处理，不要自动解。
- 更细的选择器、坐标、实测记录见 [references/dom-notes.md](references/dom-notes.md)。

## 脚本

两个脚本都是零依赖（node 内置 WebSocket），env 或 `--参数` 都能传参。

```bash
# 1) 上传视频：自动穿透 shadow root 找文件输入框
node ~/.agents/skills/wechat-channels-publish/scripts/upload-video.mjs \
  --ws "$CDP_WS" --file /abs/a.mp4 [--accept video] [--index 0] [--wait 6000]

# 2) 影子里的找/点/写：--find 里的 APP 就是 shadow root
node ~/.agents/skills/wechat-channels-publish/scripts/shadow-el.mjs \
  --ws "$CDP_WS" --find 'APP.querySelector("div.input-editor")' \
  [--click] [--end|--all] [--text 文字] [--type '#话题'] [--keys 'meta+a,Backspace'] \
  [--after '<JS>'] [--shot /tmp/x.png]
```

其余（截图、导航、取页签、渲染 HTML）用 **chrome-cdp-drive** 的 `cdp-shot` / `cdp-nav` / `cdp-eval` 即可——只要记得 `cdp-eval` 里也要自己加 `APP` 前缀。
