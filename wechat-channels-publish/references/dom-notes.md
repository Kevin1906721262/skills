# DOM 细节与实测记录（2026-09-18 实测）

视频号助手前端会改版，这里的值用于出问题时定位，不要当成硬约束。

实测环境：macOS / Chrome 152 / 调试端口 9222，登录态「刘奉钦-以学会友」，发表前视频数 12。
被测文件：`任务管理2-封面音乐版-双语字幕版.mp4`，1920×1080 h264+aac，32.49s，3.8MB。

## 入口

| 用途 | URL |
|---|---|
| 发表动态 | `https://channels.weixin.qq.com/platform/post/create` |
| 视频管理（核对用） | `https://channels.weixin.qq.com/platform/post/list` |

页签标题固定是「视频号助手」。左侧菜单：`首页 / 内容管理(视频·图文·音乐·音频) / 草稿箱 / 主页 / 活动 / 互动管理 / 直播 / 收入与服务 / 带货中心 / 数据中心 / 设置 / 通知中心`；底部是账号名。

## 无界(wujie)微前端：真实 DOM 在 shadow root 里

```
document.body
└── DIV#app.finder-page.MicroPost          ← 只有侧边栏骨架，没有表单
    └── wujie-app.wujie_iframe             ← 自定义元素
        └── #shadowRoot (open)             ← 真实页面全在这里
            └── html > div …               ← 566+ 节点
```

| 探测 | 结果 |
|---|---|
| `document.querySelectorAll("input").length` | **0**（表单里的输入框一个都看不到） |
| `document.querySelectorAll("input[type=file]").length` | **0** |
| `document.querySelectorAll("[contenteditable]").length` | **0** |
| `document.querySelector("wujie-app").shadowRoot` | 有，且 `open`（`querySelectorAll` 可穿透一层） |
| `document.activeElement`（焦点在影子里时） | 返回宿主 `<wujie-app>`，**拿不到真实聚焦元素** |

`document.querySelectorAll("iframe")` 只有一个 `https://channels.weixin.qq.com/empty.html`（0×0），**不要误判成"内容在 iframe 里"**。

## 表单页的元素（发表动态）

上传**前**：

| 用途 | 选择器 | 备注 |
|---|---|---|
| 视频文件输入 | `input[type=file]`（影子里唯一一个） | `accept="video/mp4,video/x-m4v,video/*"`、`multiple`、`style="display:none"`；DOM 路径 `doc>shadow` |
| 视频描述 | `div.input-editor`（contenteditable） | placeholder「添加描述」，rect ≈ 404×44 |
| `#话题` 按钮 | `div.finder-tag-wrap.btn` > `div.tag-inner`（文本 `#话题`） | 64×30，**只在光标处插一个 `#`** |
| `@视频号` 按钮 | 同上，文本 `@视频号` | 80×30，**只在光标处插一个 `@`** |
| 短标题 | `input.weui-desktop-form__input[placeholder*="短标题"]` | rect ≈ 416×40 |
| 发表 | `button.weui-desktop-btn_primary`，文本「发表」 | 120×40，未上传完时带 `weui-desktop-btn_disabled` |

上传**后**变化：

- `input[type=file]` 从 **1 个变 2 个**（多出来的是封面上传用的）；
- `video` 元素出现，`blob:https://channels.weixin.qq.com/...`；本次读到的 `duration 32.491 / videoWidth 1920 / videoHeight 1080`，和源文件一致；
- head 变成 `杭州市 | 刘奉钦-以学会友 | 转发 | 赞 | 评论 | 删除 | 封面预览 | 编辑 | 个人主页卡片 | 3:4 | 编辑 | 分享卡片 | 4:3 | 视频描述 | #话题 | @视频号 | 短标题 | 位置 | 添加到合集 | 选择合集 | 链接 | 选择链接 | 活动 | 不参与活动 | 定时发表 | 不定时 | 定时 | 声明原创 | … | 保存草稿 | 手机预览 | 发表`。

### 位置字段会自动带城市

两次实测给的值不同：正式那单是 `长沙市`，另开的新页签是 `杭州市` —— 是平台按账号/网络自动推的，**不要当成必须手填的字段**。

### 短标题的 tooltip 原文

鼠标悬停 ⓘ 后的 popover（`.weui-desktop-popover__desc`）：

> 短标题会出现在公众号、发现页等地方，展示给其他人。

即它和「视频描述」是两个都会被展示的字段。实测填 6 个字（`效率工具分享`）可正常发表。

## 话题（`#话题`）实测记录

### 没有联想面板（抓包确认）

点 `#话题` → 描述框里只多出一个 `#`（`div.input-editor` 的 innerHTML 变成 `#`），**页面上不出现任何候选列表**。

再逐字符输入 `效率工具`，**依然没有弹层**；随后用 Network 域监听 3.5s 并再打两个字符，抓到的请求只有：

```
https://channels.weixin.qq.com/micro/content/cgi-bin/mmfinderassistant-bin/collection/search_collection?...
---总请求数: 2
```

`collection/search_collection` 属于「添加到合集」的下拉，**没有任何 topic / subject / suggest 类接口**。结论：视频号话题是自由文本，没有「搜话题 → 选中」的流程，和抖音/小红书不一样。

另外扫了一遍 shadow root 里所有 `[class*=topic|suggest|mention|dropdown]` 元素，可见的都是各种 `weui-desktop-popover`（保存草稿/短标题/分辨率的 tooltip），**没有话题候选容器**。

### `#` 后连续文字会被整体并成一个话题

平台自己把内容包成 `<span class="hl topic" data-type="topic">…</span>`。实测三种输入：

| 操作 | `innerHTML` |
|---|---|
| 点 `#话题` → `--type '效率工具'` | `<span class="hl topic" data-type="topic">#效率工具</span>` |
| 再 `--type ' #效率工具 IDEA'` | `<span …>#任务管理</span> <span …>#效率工具</span> IDEA` |
| `--all --keys Backspace` 清空后 → `--text '#效率工具 用TEXT插入'` | `<span …>#效率工具</span> 用TEXT插入` |

要点：

- **空格是话题的结束符**，不补空格就会连成 `#任务管理IDEA` 一个话题；
- **`Input.insertText`(`--text`) 和逐字符按键(`--type`) 都能正确高亮**，说明高亮是按内容算的，不依赖输入事件（这点和抖音/小红书必须逐字符打 `#` 不一样）；
- `@视频号` 按钮实测同样只插入一个 `@`（innerHTML 变成 `@`），账号联想未测。

### 回读方式

`innerText` 分不出真话题和普通井号文字，要数 span：

```js
const e = document.querySelector("wujie-app").shadowRoot.querySelector("div.input-editor");
({ text: e.innerText, topics: [...e.querySelectorAll("[data-type=topic]")].map(t => t.innerText) })
```

## 封面

上传完成后右侧「封面预览」两张卡：

| 卡片 | 比例 | 容器 / 编辑按钮 |
|---|---|---|
| 个人主页卡片 | 3:4 | `.vertical-img-wrap`（74×98）→ `.vertical-img-wrap .edit-btn`（74×18） |
| 分享卡片 | 4:3 | `.horizon-img-wrap`（128×98）→ `.horizon-img-wrap .edit-btn`（128×18） |

本次**没有手工设封面**，平台自动抽的帧就是视频里的标题卡，两张卡都正常，发表后列表缩略图也正确。

「编辑个人主页卡片」弹窗结构：标题 `编辑个人主页卡片` + 副标题 `将会用在视频号个人主页`；左侧裁剪框（虚线区域，下方浮一个 `平铺展示` 按钮）、下方 `从视频中选择封面` 时间轴 + `上传封面`（+ 号虚线块）、右侧 `效果预览`（手机卡片 mock）、右上角 ✕。

## 发表后的表现

点「发表」后：

1. 按钮进入 loading（截图可见橙色按钮内有转圈）；
2. 约 5 秒后 URL 变成 `https://channels.weixin.qq.com/platform/post/list`；
3. 视频管理列表第一条即新视频，读取到的文本：

```
视频管理 | 特效创作工具 | 视频 (13) | 合集 (0) | 「秒剪」自动字幕，免费不限次数 | 发表视频 |
效率工具分享 | 2026年09月18日 12:23 | 0 | 0 | 0 | 0 | 0 | 置顶 | 分享 | 评论管理 | 修改描述和封面 | 可见权限 | 删除 |
2023年07月01日 21:11 | 184 | 0 | 0 | 0 | 0 | 置顶 | 分享 | 评论管理 | 可见权限 | 删除 | …
```

- 计数 0 是刚发表，正常。
- 老视频里能看到 `已声明原创`、`仅自己可见` 这类状态文字；**新视频没有状态文字**，说明默认是公开且未声明原创。
- 视频总数 12 → 13。

## 脚本实现要点

### `upload-video.mjs`

`DOM.querySelector` 从 doc root 出发**不会**下钻 shadow root，所以不能像 bilibili-publish 的 `set-file-input.mjs` 那样 `DOM.querySelector` + `--index`。

做法：`DOM.getDocument({depth:-1, pierce:true})` 拿到含 `shadowRoots` 的完整树 → 递归收集所有 `INPUT[type=file]`（同时记录 `doc>shadow` 这样的路径便于排查）→ 按 `accept` 子串筛 → 命中节点的 `nodeId` 调 `DOM.setFileInputFiles`。

### `shadow-el.mjs`

表达式统一包一层：

```js
(()=>{const H=document.querySelector("wujie-app");const APP=(H&&H.shadowRoot)||document;return (<你的表达式>);})()
```

点击走 `Input.dispatchMouseEvent`（真实鼠标），写入走先 `focus()` + `Range.selectNodeContents` + `collapse(false)` 摆光标，再 `Input.insertText`（或逐字符 `dispatchKeyEvent`）。

**静默失败的陷阱（实测）**：不带 `--end/--all` 时脚本原设计不 focus，结果 `Input.insertText` 把「短标题」的文字打进了**仍然聚焦着的视频描述编辑器** —— 命令 exit 0、没有报错，短标题仍是空。修法：只要带 `--text/--type/--keys` 就自动 focus + 摆光标，并且强制回读目标字段。

## 抽帧经验（备用，本次没用上）

若哪天要手工做封面，`ffmpeg` 抽帧时注意 **0s 往往是淡入白帧**（同一支片子在 B站流程里验证过：0.0s 纯白、1.0s 才是稳定标题卡、2.0s 第三行还在动画中）：

```bash
ffmpeg -v error -ss 1.0 -i /tmp/up.mp4 -frames:v 1 -vf scale=900:-1 /tmp/f_a.png -y
```
