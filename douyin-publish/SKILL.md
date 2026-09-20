---
name: douyin-publish
description: 通过浏览器驱动抖音创作服务平台(creator.douyin.com)网页版发布图文或视频作品——上传图片/视频、填标题与描述、加话题、设封面(时间轴推荐帧/上传自定义图)、点发布。当用户说「发个抖音」「帮我在抖音发图文/发作品/发布视频」「把这个视频发到抖音」「把这张图发到抖音」时使用。不用于：发布全景视频/文章、管理已有作品(改权限/置顶/删除)、抖音私信评论；也不用于发小红书(xiaohongshu-publish)、快手(kuaishou-publish)、知乎(zhihu-publish)、闲鱼(xianyu-publish)。
---

# 抖音：发图文 / 发视频

把一张或多张图片发成抖音图文作品，或把一个视频发成抖音视频作品。全程用 Chrome CDP 驱动已登录的浏览器。

下面第 1~8 步是**图文**流程；**发视频**的入口、字段、封面都不一样，见文末「## 发视频」。

## 前置

- 浏览器必须带调试端口（`curl -s --max-time 2 http://127.0.0.1:9222/json/version` 有 JSON）。环境搭建与取页签见 skill **chrome-cdp-drive**。
- 入口：`https://creator.douyin.com/creator-micro/content/upload?enter_from=dou_web`。目标页签 URL 含 `creator.douyin.com`；没有就 `PUT /json/new` 打开。
- 页面顶部有 `发布视频 / 发布图文 / 发布全景视频 / 发布文章` 四个 tab。走**图文**时只碰「发布图文」(入口链接默认就停在它上面；不是的话点一下)；走**视频**时保持在默认的「发布视频」,别点 tab。
- 图片规格：jpg/jpeg/png/webp/bmp/tif，≤50MB，最多 35 张，不支持 gif；推荐 3:4 或 4:3（宽高比别超过 1:2）。小红书那张 1200×1600 卡片正好是 3:4。
- **发布是不可逆的外部动作**。只在用户明确要求发布时点「发布」；用户只是想准备好内容时，填完表单停下并告知。文案、图片、话题以用户给的为准。**用户没给文案/话题时，发布前先问**。

## 图片来源

**优先用用户给的图**：本地文件路径、拖进对话的图片、截图都算 —— 直接用。缺图时按 skill **xiaohongshu-publish** 走「文字配图 → 生成图片」，到「预览图片」页取 `img.swiper-img` 的 `currentSrc` 下载原图（实测 1200×1600 jpg），**不点「下一步」、不发小红书笔记**。

## 标准流程

1. **上传图片** —— 页面有 **2 个** `input[type=file]`：`[0]` 是视频（`accept=video/*`），`[1]` 才是图片（`multiple`）。用 CDP DOM 域按序号塞文件（`cdp-eval` 走 Runtime 域做不到）：

   ```bash
   node ~/.agents/skills/douyin-publish/scripts/set-file-input.mjs \
     --ws "$CDP_WS" --file /abs/path/card.jpg --index 1 --wait 5000
   ```

   上传成功后页面从上传区切到「作品发布」表单（右侧出现手机预览）。等 2~4s 再做下一步。

2. **填标题和描述** —— 标题是 `input[placeholder="添加作品标题"]`（上限 20 字，React 受控，走原生 setter + `input`/`change`）；描述是 `div[contenteditable=true]`（上限 1000 字），光标收拢到末尾后用 `document.execCommand("insertText", false, 文案)` 注入。计数分别是 `19/20` 和 `19 / 1000`（描述计数里带空格），拿它当注入成功的判据。

3. **改文案只能用真实键盘，不要重复用 execCommand** —— 描述编辑器是受控的富文本，**程序化二次编辑会被框架回写**：实测「选中全部 → delete → 重新 insertText」会把开头三个字复制一遍（19 字变 21 字）。要改文案或补救，用真实按键：先聚焦编辑区，再 `Cmd+A` → `Backspace` → 输入新文案。`scripts/` 里没带按键脚本，用 chrome-cdp-drive 的 `cdp-type.mjs` + CDP `Input.dispatchKeyEvent` 自己发即可。

4. **加话题** —— 顺序很关键：
   - 先把光标放到描述末尾（`focus()` → Range 收拢到末尾）。
   - 点 `div.toolbar-button-spPS4r` 中文本为 `#添加话题` 的按钮：它在**光标处**插入 `#` 并弹出联想面板（`.mention-suggest-mount-dom`，列表容器 `.mention-suggest-item-container-TVOZMl`）。
   - 输入关键词（真实输入，`Input.insertText` 即可），面板按关键词过滤。
   - 点文本精确等于 `#关键词` 的那一项（每行是两个 div：话题名 + 热度值）。选中后变成真话题 chip，DOM 里是 `[data-mention]`。
   - 校验：`editor.querySelectorAll("[data-mention]").length` 等于话题个数。
   - 坑一：别用键盘直接敲 `#` 起头——实测把光标放在正文中间时敲 `#字幕`，`#` 被联想逻辑吃掉、还插错位置。走「点按钮」这条路。
   - 坑二：关键词要补全到目标话题。打「双语」没有 `#双语字幕`，补成「双语字幕」才出现（1.3亿）。实在没有的，就选最贴近的近似话题。
   - 坑三：面板下面那排「推荐」胶囊（单词/高校/姓名学/中考英语…）基本跟内容无关，别点。

5. **封面 / 音乐 / 位置 / 热点 / 官方活动** —— 封面默认取第一张图，不用动；`选择音乐` 默认是空的（提示「点击添加合适作品风格音乐」），图文不需要音乐，用户没要求就别点开；位置、关联热点默认空；官方活动不勾。

6. **发布设置** —— `谁可以看`=公开、`保存权限`=允许、`发布时间`=立即发布，都是默认值。用户没单独要求就保持默认，改了就截图核对。

7. **发布** —— 底部固定栏里的 `BUTTON.button-dhlUZE.primary-cECiOJ.fixed-J9O8Yw`（文本「发布」，黑色 120×32），旁边是 `暂存离开`。普通 button，`cdp-click` 按文本 + `primary` 类名匹配即可。点完会跳 `.../content/manage?enter_from=publish`，并弹出「本次作品发布过程的满意度」问卷。

8. **确认结果（有坑）** —— 刚跳转过去的作品列表是**缓存的**：新作品还没进去，`作品 (N)` 还是旧数字，看起来像没发出去。必须**刷新页面**（`location.reload()`）后再看：`作品` 计数 +1，列表顶部出现你的标题、`2026年09月14日 22:32` 形式的发布时间、`已发布`、体裁 `1张`、播放 0。以刷新后的这条为准，别拿那个满意度问卷当成功证据。

## 发视频

入口、字段、封面**和图文都不一样**,别照搬上面的步骤号。

### 上传

- 入口同图文:`.../creator-micro/content/upload?enter_from=dou_web`,默认停在 `发布视频` tab(不用点)。
- 视频页**只有一个** `input[type=file]`(`accept=video/*,.mp4,…`),`set-file-input.mjs --index 0` 直接塞就认:
  ```bash
  node ~/.agents/skills/douyin-publish/scripts/set-file-input.mjs \
    --ws "$CDP_WS" --file /abs/path/video.mp4 --index 0 --wait 8000
  ```
  它返回的 `filesAfter` 是 **0**,**别拿它判断成败** —— 判据是页面从上传区切到「作品发布」表单(出现 `基础信息` / `作品描述` / `设置封面`),URL 变成 `.../content/post/video?enter_from=publish_page`;上方 toast 走 `上传中,请勿关闭页面…` → `上传成功`。
- 上传成功后会弹一次「视频预览功能」气泡,点 `我知道了` 关掉,否则它压住右侧手机预览。

### 文案字段(比图文多一个标题)

- `作品描述` 行里有**两个**控件:
  - **标题** `input[placeholder="填写作品标题，为作品获得更多流量"]`,上限 **30** 字(计数器 `21/30`);图文是 20 字、占位符也不同,别抄错。
  - **简介** `div.editor-comp-publish[contenteditable=true]`,上限 1000(计数器 `176 / 1000`)。
- 简介就是图文那套富文本编辑器,写法见 skill **chrome-cdp-drive** §5.5 —— **用 `cdp-keys.mjs` 的 `CDP_SEL_END` + `CDP_TEXT`,不要用 `cdp-type.mjs`**(它会往元素中心点一下鼠标,把光标挪到正文中间;这次实测就把 `任务管理` 插进了"被消息反复**任务管理**打断之后")。话题 chip 一律用 `CDP_TYPE` 逐字符打 `#关键词`,再点 `.mention-suggest-item-container-TVOZMl .tag-dVUDkJ` 里名字相同的项。
- 实测可用话题(热度):`#任务管理`(300.7万)、`#效率工具`(11.5亿)、`#程序员`(675.4亿)、`#DeepSeek`(255.5亿)。校验 `editor.querySelectorAll("[data-mention]").length` 等于话题数。

### 封面(最容易卡住的一步)

- `设置封面` 有**两个槽位**:`div.cover-Jg3T4p` ×2,分别标注 `横封面4:3` / `竖封面3:4`,默认取视频第一帧 —— **第 0 帧是白/黑的视频一定要改**(这次那个视频开头是淡入白帧,默认封面就是一片白)。
- 点槽位 → 打开封面编辑器(左栏 `AI封面/模板/贴纸/标题/文字/滤镜`),两种来源:
  - **用视频帧(推荐)**:底部时间轴 `div.preview-frame-rt7Mc1`;**带 `div.recommend-bubble-JPbArG` 标记的就是抖官方标的「推荐」帧**,优先选它。**必须用真实坐标点击**(`Input.dispatchMouseEvent`),`.click()` 不生效;点完画布会换帧(可读 `canvas.getImageData` 的平均色确认变了)。
  - **上传自定义图**:点上传区(文本容器 `div.upload-tips-KomyJM`)→ 图片槽 `index 0` → 弹裁剪框 → 点 `button.primary-cECiOJ`(文本 `保存`)→ 回编辑器 → 点 `完成`。
- 横封面点 `完成` 后,抖音会弹「设置竖封面获更多流量」(`暂不设置` / `设置竖封面`)——**两个槽位都要设**,不然另一个留白。
- **`AI智能推荐封面` / AI封面 可能永远停在「生成中」**(实测轮询 75 秒没出来),别死等,直接回落时间轴推荐帧。
- **判断封面有没有生效:回表单看封面 `<img>` 的 `src` 是不是变成了 `p0-creator-media-private.douyin.com/...`**。→ 不要用编辑画布的平均色判断:编辑器画布一直显示视频帧,上传的图是另一层,看着还是白的(这次就因此误判成"上传失败")。那个私有域名的图直接 `fetch` 会返回 **403**(不带 cookie),别当失败。
- ⚠️ **录屏类内容躲不过质检**:即使换成抖音自己标的推荐帧,仍会打 `封面不佳` / `请勿使用截屏当封面` / `封面存在2个问题,会导致作品流量减少`。这是内容属性不是操作问题;想要干净封面得单独做一张不依赖录屏截图的图。

### 发布与验证

- `发布` 还是底部固定栏的 `button.button-dhlUZE.primary-cECiOJ.fixed-J9O8Yw`(文本精确 `发布`,120×32,旁边 `暂存离开`),图文视频共用同一个按钮。
- 发布设置默认值就能发:`谁可以看`=公开、`保存权限`=允许、`发布时间`=立即发布。
- 点完跳 `.../content/manage?enter_from=publish`,**列表是缓存的**,必须 `location.reload()` 后再看:`作品 (N)` 计数 +1、列表顶部出现标题、`2026年09月16日 23:43` 形式的发布时间、状态 `审核中`、时长 `00:32`。以刷新后这条为准,别拿"本次作品发布过程的满意度"问卷当证据。

## 出问题时

（以下是**图文**专属的;发视频的问题见上面「发视频」一节。）

- 上传没反应：确认用的是 `--index 1`（`[0]` 是视频输入框，塞 jpg 进去不报错但也不会进入图文流程）。
- 描述被改成重复内容：见第 3 步，改用真实键盘重做，别继续用 execCommand 叠加。
- 话题点不动 / 没变成 chip：确认点在「话题名」那个 div 上；每加完一个话题面板会自动关闭，下一个要重新点 `#添加话题`。
- 发布后列表没变化：先刷新页面再判断（第 8 步）。
- 出现验证码/安全验证：截图让用户手动处理，不要自动解。
- 更细的选择器、坐标、实测记录见 [references/dom-notes.md](references/dom-notes.md)。

## 脚本

`scripts/set-file-input.mjs` —— 用 CDP DOM 域把本地文件塞进页面的 `input[type=file]`，支持 `--index` 选第几个输入框（与 skill **xianyu-publish** 里的同名脚本是同一个工具，各带一份以保持自包含）。

```bash
node .../set-file-input.mjs --ws "$CDP_WS" --file /abs/path/card.jpg --index 1 [--selector "input[type=file]"] [--wait 5000]
```

其余步骤（标题、描述、话题、发布）用 **chrome-cdp-drive** 的 `cdp-eval` / `cdp-click` / `cdp-type` 即可。
