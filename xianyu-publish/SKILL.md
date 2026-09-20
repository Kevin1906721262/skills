---
name: xianyu-publish
description: 通过浏览器驱动闲鱼(goofish.com)网页版发布闲置/服务类商品——上传图片、写宝贝描述、设价格与原价、选分类、点发布。当用户说「发个闲鱼」「帮我在闲鱼发布/发闲置」「把这张图+这段文案发到闲鱼」时使用。不用于：管理已有商品(改价/下架/删除)、下单购买、闲鱼 App 专属操作；也不用于发小红书(xiaohongshu-publish)、抖音(douyin-publish)、快手(kuaishou-publish)、知乎(zhihu-publish)。
---

# 闲鱼发闲置：上传图片 → 描述/价格 → 发布

把一张图和一段描述变成闲鱼商品。全程用 Chrome CDP 驱动已登录的浏览器。

## 前置

- 浏览器必须带调试端口（`curl -s --max-time 2 http://127.0.0.1:9222/json/version` 有 JSON）。环境搭建与取页签见 skill **chrome-cdp-drive**。
- 目标页签 URL 含 `goofish.com/publish`；没有就 `PUT /json/new` 打开入口链接。
- **发布是不可逆的外部动作**。只在用户明确要求发布时点「发布」；用户只是想准备好内容时，把表单填完就停下并告知。文案、图片、价格以用户给的为准，不要自行改写或加营销话术。

## 图片来源

**优先用用户给的图**：本地文件路径、拖进对话的图片、截图都算 —— 直接用，不要自作主张再生成一张。

**用户没给图时，默认自动生成**，不必先问：走 skill **xiaohongshu-publish** 的「文字配图」，到「预览图片」页把卡片原图取下来即可。

- 入口 `https://creator.xiaohongshu.com/publish/publish?source=official&from=menu&target=image`，点 `文字配图`。
- 卡片文案用**用户给的宝贝描述原文**，不要另写、不要加话题标签；太长就在标点处拆成几行。
- 点 `生成图片`，到了「预览图片」页**就此打住**：不点「下一步」、更不要发小红书笔记。
- 取卡片原图（实测 1200×1600 jpg）：

  ```js
  document.querySelector("img.swiper-img").currentSrc   // https://sns-na-i4.xhscdn.com/zeusengine-gpu-server/zs2tab_*.jpg
  ```

  ```bash
  curl -sSL -o /tmp/card.jpg "<上面的 URL>"
  ```

- 只有这条路走不通时才回头找用户要图（小红书未登录、页面改版、生成失败），并把卡在哪一步讲清楚。

## 标准流程

入口：`https://www.goofish.com/publish`

1. **上传图片** —— 页面只有一个隐藏的 `input[type=file]`（`multiple`，`accept` 图片格式），对应「添加首图」。这件事 `cdp-eval` 做不到（它只走 Runtime 域），要用 CDP DOM 域：

   ```bash
   node ~/.agents/skills/xianyu-publish/scripts/set-file-input.mjs \
     --ws "$CDP_WS" --file /tmp/card.jpg
   ```

   成功标志：出现首图缩略图，上传框文案由「添加首图」变「添加细节图」。等 2~4s 再往下走。

2. **写宝贝描述** —— 编辑区是 `div[contenteditable=true]`（class `editor--*`，无 placeholder），右侧计数 `n/1500`。聚焦 → Range 收拢到末尾 → 注入文本：

   ```js
   const ed = document.querySelector("div[contenteditable=true]");
   ed.focus();
   const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false);
   const s = getSelection(); s.removeAllRanges(); s.addRange(r);
   document.execCommand("insertText", false, "描述文案");
   ```

   注入后**必须核对右侧计数**（如 `19/1500`）：计数不变说明框架没收到，别继续。

3. **填价格与原价** —— 两个 `input.ant-input[placeholder="0.00"]`，**按 DOM 顺序第 1 个是「价格」，第 2 个是「原价」**（页面里还有第 3 个同 placeholder 的输入，别只按 placeholder 去猜）。React 受控，走原生 setter + `input`/`change` 事件：

   ```js
   const el = document.querySelectorAll('input.ant-input[placeholder="0.00"]')[0];
   el.focus();
   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "0.5");
   el.dispatchEvent(new Event("input", { bubbles: true }));
   el.dispatchEvent(new Event("change", { bubbles: true }));
   ```

   填完页面会显示「预估基础软件服务费 (0.6%)」和「预估到手价 (含运费)」，用它反查价格有没有填对。

4. **分类固定选「其他闲置」** —— 这是本 skill 的硬规则，不用问用户。
   - 上传图片、填完描述后，闲鱼会智能识别一个分类，可能是完全不相干的「女士连衣裙」，也可能识别成听起来很对的「视频剪辑/制作」。**一律改掉。**
   - 原因：所有服务类分类在网页版都被禁。选中后页面出现「网页版暂不支持发布此分类，请使用闲鱼APP扫码继续发布」——实测 `视频剪辑/制作`、`音频制作/处理`、`广告视频制作`、`其他服务`、`其他技能服务`、`其它互联网/软硬件相关服务` 全都是这个提示，只有普通分类能发。
   - 操作：点唯一的 `.ant-select`（显示当前分类）→ 等 `.ant-select-dropdown` 出现 → 点文本精确等于 `其他闲置` 的 `.ant-select-item-option-content`。
   - 校验：改完后 `document.body.innerText.includes("网页版暂不支持")` 必须为 `false`。
   - **顺序**：智能识别会在填完描述后重跑并覆盖你刚选的分类，所以分类放在描述之后设。

5. **其余字段保持默认** —— 发货设置 4 个 radio（包邮 / 按距离计费 / 一口价 / 无需邮寄，默认「包邮」）、支持自提开关、宝贝所在地（账号预填，如「文景家园」）。用户单独提了要求才改，改完截图核对。

6. **发布** —— 底部固定栏里的 `BUTTON.publish-button--*`（文本「发布」，约 240×48）。这里**不是**闭 shadow root，`cdp-click` 按文本精确匹配即可：

   ```bash
   CDP_WS="$CDP_WS" CDP_FIND='(()=>{const e=[...document.querySelectorAll("button")].filter(x=>(x.textContent||"").trim()==="发布")[0]; return e||null;})()' \
     node ~/.agents/skills/chrome-cdp-drive/scripts/cdp-click.mjs
   ```

7. **确认结果** —— 成功后自动跳到商品页 `https://www.goofish.com/item?id=<id>&...&spm=a21ybx.publish.0.0`，页面显示价格、原价、描述、图片，以及只有卖家可见的「下架 / 删除」按钮。**以这个商品 URL 作为发布成功的证据**（把它给用户），不要拿首页或「我发布的」列表当结论。

## 出问题时

- 图片没上传成功：确认 `--file` 是绝对路径、`DOM.setFileInputFiles` 的 `nodeId` 来自同一连接的 `DOM.querySelector`（nodeId 是会话级的），设完等 3~4s 再看缩略图。
- 描述没进去：编辑器是受控组件，不要用 `innerText` 赋值；回到 `execCommand("insertText")`，必要时先点一下编辑区再执行。
- 价格不生效：`input` 和 `change` 两个事件都要派发，然后回读 `.value` 与「预估到手价」。
- 分类改完又跳回去：见第 4 步的「顺序」。
- 出现验证码/滑块：截图让用户手动处理，不要自动解。
- 更细的 DOM 细节：见 [references/dom-notes.md](references/dom-notes.md)。

## 脚本

`scripts/set-file-input.mjs` —— 用 CDP DOM 域把本地文件塞进页面的 `input[type=file]`（`cdp-eval` 走 Runtime 域做不到）。

```bash
node .../set-file-input.mjs --ws "$CDP_WS" --file /abs/path/card.jpg [--selector "input[type=file]"] [--index 0] [--wait 3000]
```

其余步骤（描述、价格、分类、点发布）用 **chrome-cdp-drive** 的 `cdp-eval` / `cdp-click` 就够了。
