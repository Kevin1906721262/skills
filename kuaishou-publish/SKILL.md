---
name: kuaishou-publish
description: 通过浏览器驱动快手创作者服务平台(cp.kuaishou.com)网页版发布图文或视频作品——上传图片/视频、写作品描述、加话题、加音乐、设封面(智能推荐封面/上传封面)、点发布。当用户说「发个快手」「帮我在快手发图文/发作品/发布视频」「把这个视频发到快手」时使用。注意:**快手视频上传不认 CDP 塞文件**(setFileInputFiles 和文件选择框拦截都不生效),要换系统文件对话框这条路,见「## 发视频」。不用于：发布全景视频、管理已有作品、私信评论；也不用于发小红书(xiaohongshu-publish)、抖音(douyin-publish)、知乎(zhihu-publish)、闲鱼(xianyu-publish)。
---

# 快手：发图文 / 发视频

把图片发成快手图文作品，或把视频发成快手视频作品。全程用 Chrome CDP 驱动已登录的浏览器。

下面第 1~7 步是**图文**流程；**发视频**的入口、上传方式、字段都不一样，见文末「## 发视频」。

## 前置

- 浏览器必须带调试端口（`curl -s --max-time 2 http://127.0.0.1:9222/json/version` 有 JSON）。环境搭建与取页签见 skill **chrome-cdp-drive**。
- 入口：`https://cp.kuaishou.com/article/publish/video?origin=www.kuaishou.com&source=NewReco`。目标页签 URL 含 `cp.kuaishou.com`；没有就 `PUT /json/new` 打开。
- **这个入口默认停在「上传视频」**（新开页签一定是），必须先点顶部 `上传图文` tab（`.ant-tabs-tab-btn`，文本精确匹配）。顶部还有 `上传全景视频`，别碰。
- 图片规格：最多 31 张、单张 ≤15MB，支持 png/jpg/jpeg/webp，不支持 gif/livp，**推荐 3:4 竖版**（小红书那张 1200×1600 卡片正好合适）。
- **发布是不可逆的外部动作**。只在用户明确要求发布时点「发布」；用户只是想准备好内容时，填完表单停下并告知。文案、图片、话题以用户给的为准；用户没给就发布前先问。

## 图片来源

**优先用用户给的图**（本地路径、对话里的图、截图）。缺图时按 skill **xiaohongshu-publish** 走「文字配图 → 生成图片」，到「预览图片」页取 `img.swiper-img` 的 `currentSrc` 下载原图，**不点「下一步」、不发小红书笔记**。

## 标准流程

1. **上传图片（本 skill 最关键的坑）** —— 页面有 **2 个** `input[type=file]`：`[0]` 视频、`[1]` 图片。**直接设 `input.files` 在这里无效**：`DOM.setFileInputFiles` 会返回成功，但 `files.length` 仍是 0、页面毫无反应（组件要求真实用户手势，还会把 input 清空）。必须走「真实点击 → 拦截系统文件选择框」：

   ```bash
   node ~/.agents/skills/kuaishou-publish/scripts/upload-via-file-chooser.mjs \
     --ws "$CDP_WS" --file /abs/path/card.jpg --wait 7000
   ```

   脚本做的事：`Page.setInterceptFileChooserDialog` → 真实鼠标点击「上传图片」→ 等 `Page.fileChooserOpened` 拿 `backendNodeId` → `DOM.setFileInputFiles({backendNodeId, files})`。

   成功标志：页面从上传区切到「发布图文」表单（右侧出现手机预览），`编辑图片` 显示 `1/31`。

2. **写作品描述** —— 快手**没有单独的标题字段**，只有一个「作品描述」`div[contenteditable=true]`（上限 500 字）。光标收拢到末尾后注入：

   ```js
   const ed = document.querySelector("div[contenteditable=true]");
   ed.focus();
   const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false);
   const s = getSelection(); s.removeAllRanges(); s.addRange(r);
   document.execCommand("insertText", false, "描述文案");
   ```

   判据：右下角计数从 `0/500` 变成 `19/500`，等 2 秒再看是否稳定（实测一次注入可靠）。

3. **加话题** —— 顺序很重要：
   - **先把光标放到描述末尾**（`focus()` → Range 收拢到末尾），否则下一步的 `#` 会插到光标所在位置。
   - 点文本为 `#话题` 的 `span`（条件：`children.length === 0`，宽高 > 20×15）：它在光标处插入 `#` 并弹出联想面板。
   - 输入关键词（`Input.insertText` 即可），面板按关键词过滤；列表项 class 含 `topic-item`，每项 `innerText` 是 `#` / 话题名 / 播放量 三行。
   - 点**话题名那行对应的 item**（判定：`innerText` 拆行后第二行 === 目标话题名）。
   - 校验：`ed.querySelectorAll(".at-tag-item").length` 等于话题数。话题加完面板会自动关闭，下一个重新点 `#话题`。
   - 实测可用话题：`#字幕`（5703.7w 播放）、`#双语字幕`（633.9w）、`#字幕制作`（335.7w）。关键词要打全——搜「双语」和「双语字幕」出来的列表不一样。
   - 面板底部/页面的「推荐」话题胶囊基本与内容无关，别点。

4. **加音乐（可选）** —— 右侧「发布助手 → 作品检测」默认报 ⚠ **作品未添加音乐**（提示加了能提升曝光、拿更多流量）。用户没要求可以不加；用户要加时：
   - 点 `添加音乐` / `更换音乐` 打开右侧抽屉「选择音乐」。
   - **搜索框必须用原生 setter 清空并赋值**：`Cmd+A → Backspace` 清不干净，会把关键词叠成 `纯音10短音卡纯音乐`，导致搜出来的结果莫名其妙。
   - 列表项 class 含 `item_`，每行尾有独立的**「添加」按钮**（`div._button_primary`，文本 `添加`）——**点整行不生效，必须点那个「添加」**。
   - **点之前确认抽屉在视口内**：抽屉关着时它停在 `x=1440`（视口外），选择器照样命中，点了没有任何反应。判断行 `getBoundingClientRect().x` 在 900~1400 之间。
   - **音乐时长没有裁剪入口**，只能按曲库里的原长挑：搜 `10秒` 能搜到 13 首正好 10 秒的图虫短音轨（误解10秒 / 早鸟10秒 / 崇拜10秒 / 深情10秒…）；`15秒` 一批 15 秒；搜 `纯音乐` 最短 28 秒（纯音乐（夏天）），`短音乐` 最短 18 秒（大展宏图-短音乐版）。图文要短音乐就直接搜 `10秒`。
   - 加完 widget 显示 `曲名 00:00 | 00:10`，作品检测变成 ✅ 作品已添加音乐；旁边有 `更换音乐` / `删除`。

5. **其余默认** —— 封面=默认（取第一张图）、作者服务/作者声明/添加地点留空、查看权限=所有人可见、发布时间=立即发布。用户没单独要求就别动。

6. **发布** —— 底部表单里的 `发布`（`div._button_primary_3a3lq_60`，96×36，红色，旁边是 `取消`）。普通 div，不是 shadow DOM，`cdp-click` 按文本 + `primary` 类名匹配即可。点完跳到 `https://cp.kuaishou.com/article/manage/video?status=2&from=publish`。

7. **确认结果** —— 跳转后默认在「待发布」tab，列表顶部出现新作品：描述 + 话题，状态 `审核中`。点 `全部作品` tab 能看到总数与各条状态（`已发布` / `审核中` / `未通过`）。以这条列表记录为准。
   - 快手列表**不暴露作品 id、也没有 `<a href>`**，拿不到公网播放链接；要分享只能在 App 里。别承诺给用户链接。

## 发视频

### 上传(本 skill 最大的坑)

- 入口就是图文那个入口:`https://cp.kuaishou.com/article/publish/video?origin=www.kuaishou.com&source=NewReco`。它默认停在 `上传视频`,**发视频不用点 tab**(发图文才要点 `上传图文`)。
- 页面只有一个 `input[type=file]`(在 `button._upload-btn_1j3uy_87`(文本 `上传视频`)那一组里,`accept=video/*,.mp4,…`)。
- ❌ **`DOM.setFileInputFiles` 不生效**:返回 success、`files.length` 立刻回 0、页面纹丝不动、**Network 域里一条上传请求都没有** —— 所以这不是"传得慢",是真没触发。
- ❌ **文件选择框拦截(`upload-via-file-chooser.mjs`)也不生效**:同一脚本在**图文**页是有效的;在视频页 `Page.fileChooserOpened` 拿得到 `backendNodeId`、`setFileInputFiles` 也返回成功,但结果一样(零请求、零变化)。**别在"拦截成功"这个假象上反复重试。**
- ✅ 实测能过的是**系统文件对话框**:CDP 真实点击 `上传视频` → macOS 弹「打开」面板 → 用 AppleScript 把绝对路径送进去 → 面板关闭、视频开始处理。
  ```bash
  node ~/.agents/skills/chrome-cdp-drive/scripts/upload-via-native-dialog.mjs \
    --ws "$CDP_WS" --file /tmp/clip.mp4 \
    --find '[...document.querySelectorAll("button")].filter(b=>(b.textContent||"").trim()==="上传视频"&&b.getBoundingClientRect().width>40)[0]||null'
  ```
  ⚠️ 这条路 **仅 macOS、且不稳**(真实项目里成功过一次,事后用测试页反复复现都是"对话框开着、文件没进去")。**失败就停手,让用户自己在对话框里选文件**,不要反复重试(每次都要抢前台焦点)。脚本头部注了四个实测坑(必须 `tell process`;别碰 `text field 1`,那是搜索栏;`Esc` 是验键盘通道的探针;sheet 未必挂 `window 1`)。
- **上传成功的判据(必须查,别信"没报错")**:
  ```js
  (()=>{const v=document.querySelector("video");return v?{dur:v.duration,w:v.videoWidth,h:v.videoHeight}:null})()
  ```
  `dur` / `videoWidth` 要和源文件对得上(本次实测 `32.490667` / `1920x1080`),页面会从上传区切到 `发布视频` 表单(`作品描述` / `封面设置` / `发布设置`)。
- 传之前先 `cp` 一份 ASCII 路径(`/tmp/clip.mp4`)再用,省掉中文名在系统对话框里的输入法问题。

### 文案字段

- 只有**一个** `作品描述`(`div._description_17g9x_24`,`contenteditable=true`),上限 **500** 字,**没有独立标题字段**。
- **实测这个编辑器没有话题联想面板**:打 `#任务管理` 不弹列表。所以话题**直接以纯文本写在描述末尾**(`#任务管理 #效率工具 #程序员 #人工智能`),发布后平台会识别成话题。别在这儿等联想面板、也别去点页面上那些 `推荐:` 胶囊。
- 写法:用 skill **chrome-cdp-drive** 的 `cdp-keys.mjs`(`CDP_SEL_END` 收拢光标 + `CDP_TEXT` 带 `\n` 分段),**不要用 `cdp-type.mjs`**。

### 封面

- `封面设置` 区:左边是**当前封面**`div._cover-full-editor_ps02t_40`(默认取视频第一帧),右边是**`智能推荐封面`**(`div._recommend-cover-item_ps02t_176` 共三张)。
- **用推荐封面(省事)**:直接点某张推荐卡 → 弹 toast **`封面应用成功`**,左侧缩略图随即换成它。黑帧占一张,内容帧是带界面/字幕的那几张,挑有内容的。
- **自己选帧/传图**:点左侧封面打开封面编辑器,顶部两个 tab:`封面截取`(拖时间轴选帧,拇指条是 `div` 缩略图)/ `上传封面`(点 `上传图片` → 图片 `index 1` 或 `2` 的 `input[type=file]`)。
  - ⚠️ 编辑器底部那个 `确认`(约 `x=1016,y=611`,右边是 `去编辑`)是**保存当前封面选择**,不是关闭。点它会把"当前选中的帧"存成封面 —— 想放弃就用右上角关闭按钮 `img._header-close_2t3fe_67`,会弹「确定退出吗?退出将不保存封面选取效果」,点 `div.ant-modal-confirm-btns button.ant-btn-primary`(文本 `确 认`)退出;别点成旁边那个 `取消`。

### 发布与验证

- `发布` 是底部表单里的 **`DIV`**(`div._button_3a3lq_1` + `_button-primary_...`,96×36,红色,旁边是 `取消`),不是 shadow DOM,`cdp-click` 按文本 `发布` + `primary` 类名匹配即可。
- 点完跳 `https://cp.kuaishou.com/article/manage/video?status=2&from=publish`,列表出现 `共N个作品` + 你的描述 + 状态 `审核中`。以这条记录为准(快手列表不暴露作品 id 和公网链接,别承诺给用户链接)。

## 出问题时

（以下是**图文**专属的;发视频的问题见上面「发视频」一节。）

- 图片没上传成功：几乎一定是没走文件选择框那条路，回到第 1 步用 `upload-via-file-chooser.mjs`；确认点击的是「上传图片」而不是别处的同名文案。
- 话题没变成 chip：`#` 插到了正文中间（光标记错）→ 全文重做；或点到了行容器而不是话题名那一项。
- 音乐点「添加」没反应：抽屉在视口外，先确认行的 x 坐标（见第 4 步）。
- 搜不到想要的音乐：搜索框没清干净（叠加了上一次的关键词）；用原生 setter 重设。
- 出现验证码/安全验证：截图让用户手动处理，不要自动解。
- 更细的选择器、实测记录见 [references/dom-notes.md](references/dom-notes.md)。

## 脚本

`scripts/upload-via-file-chooser.mjs` —— 真实点击 + 拦截原生文件选择框 + `DOM.setFileInputFiles`。适用于页面不肯吃直接塞文件的站点（快手就是）。

```bash
node .../upload-via-file-chooser.mjs --ws "$CDP_WS" --file /abs/path/card.jpg [--find '<JS 返回要点的元素>'] [--wait 7000]
```

⚠️ **这个脚本只对图文的图片上传有效,对视频无效**(见「## 发视频」)。视频要改用 skill **chrome-cdp-drive** 的 `upload-via-native-dialog.mjs`(macOS、不稳、失败就停手让用户手动选)。

其余步骤（描述、话题、音乐、发布）用 **chrome-cdp-drive** 的 `cdp-eval` / `cdp-click` / `cdp-type` 即可。
