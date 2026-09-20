# DOM 细节与实测记录（2026-09 实测）

闲鱼前端会改版，这里的值用于出问题时定位，不要当成硬约束。

## 页面结构（`https://www.goofish.com/publish`）

从上到下：`标题栏(闲鱼 Logo / 昵称 / 订单)` → `发闲置` → `基础信息` →
`宝贝图片*` → `宝贝描述*` → `分类*` + 动态属性字段 → `价格` → `发货设置` → `宝贝所在地` → 底部固定栏 `发布`。

关键元素（1440×669 视口实测）：

| 用途 | 选择器 | 备注 |
|---|---|---|
| 首图文件输入 | `input[type=file]` | 全页仅 1 个，`multiple`，`accept="image/png, image/jpg, image/jpeg, image/heic, image/webp"`，`style="display:none"` |
| 宝贝描述 | `div[contenteditable=true]` | class `editor--MtHPS94K`（哈希会变），受控组件 |
| 描述计数 | 文本 `n/1500` | 注入成功与否的判据 |
| 分类下拉 | `.ant-select` | 全页仅 1 个 |
| 分类选项 | `.ant-select-item-option-content` | 文本精确匹配 |
| 价格 / 原价 | `input.ant-input[placeholder="0.00"]` | 按 DOM 顺序：`[0]`=价格、`[1]`=原价，`[2]` 是另一个同 placeholder 的输入 |
| 发货设置 | `input[type=radio]` ×4 | 依次 包邮 / 按距离计费 / 一口价 / 无需邮寄；默认选 `[0]` 包邮 |
| 发布按钮 | `button.publish-button--KBpTVopQ` | 文本「发布」，240×48，**普通 button，不是 shadow DOM** |

## 上传图片

- 只能走 CDP DOM 域：`DOM.getDocument({depth:-1,pierce:true})` → `DOM.querySelector` → `DOM.setFileInputFiles`。
  `cdp-eval.mjs` 只走 Runtime 域，塞不了 `File`（页面里构造 `DataTransfer` 也行，但要把图片 base64 塞进表达式，不如直接给路径）。
- 成功标志：上传框文案从「添加首图」变「添加细节图」，出现 `img` 缩略图（`img.alicdn.com/...fleamarket.jpg`）。
- 上传后闲鱼会做智能识别：实测先猜成「女士连衣裙」，并带出 品牌/成色/尺码/适用季节/面料/裙长 一组属性字段；换分类后这些字段会消失。

## 分类：所有服务类都发不了（重点）

下拉里可选的项：`视频剪辑/制作`、`音频制作/处理`、`广告视频制作`、`存储数据恢复`、`其他服务`、
`其它互联网/软硬件相关服务`、`动画制作`、`其他技能服务`、`刻录盘个性化服务`、`其他闲置`。

逐个实测，选中后页面是否出现「网页版暂不支持发布此分类，请使用闲鱼APP扫码继续发布 点击展示二维码」：

| 分类 | 网页端 |
|---|---|
| 视频剪辑/制作 | ❌ APP-only |
| 音频制作/处理 | ❌ APP-only |
| 广告视频制作 | ❌ APP-only（有时不在建议列表里） |
| 其他服务 | ❌ APP-only |
| 其他技能服务 | ❌ APP-only |
| 其它互联网/软硬件相关服务 | ❌ APP-only |
| 其他闲置 | ✅ 可发 |

所以：**分类固定选「其他闲置」**，不要因为描述里提到「剪辑/字幕」就留在 `视频剪辑/制作` 上。
如果用户明确要挂在服务分类下，只能让他用手机闲鱼扫码（页面上「点击展示二维码」），网页端做不到。

判断方式：`document.body.innerText.includes("网页版暂不支持")`。

## 描述编辑器

- `div[contenteditable=true]`，class `editor--MtHPS94K`（CSS module 哈希，会变）。
- `innerHTML` 注入后是**裸文本**（没有框架包装的 `<div>`/`<span>`），但受控组件确实收到了——判据是右侧计数从 `0/1500` 变成 `19/1500`。
- 注入方法：`focus()` → Range 收拢到末尾 → `document.execCommand("insertText", false, text)`，返回 `true`。

## 价格

- 顺序坑：全页有 **3 个** `input.ant-input[placeholder="0.00"]`（多出来的是隐藏的移动端/冗余节点），按 DOM 顺序取前两个。
- React 受控：原生 setter + `input` + `change` 两个事件。
- 回读判据：页面显示「预估基础软件服务费 (0.6%) ¥0」「预估到手价 (含运费) ¥0.50」——价格 0.5 时到手价也是 0.50。

## 发布结果

- 点「发布」后无二次确认弹窗，直接跳转 `https://www.goofish.com/item?id=<id>&categoryId=&spm=a21ybx.publish.0.0`。
- 商品页（卖家视角）显示：`¥ 0.50  原价¥5  包邮`、`1浏览`、描述文本 + 「感兴趣的话点“我想要”和我私聊吧～」、右侧「下架 / 删除」按钮。
- 实测商品 id 形如 `1083911161033`（13 位）。

## 环境备忘

- Chrome CDP 端口 9222；驱动方式见 skill **chrome-cdp-drive**。
- 本机 `~/.codex/skills` 只有 `.system`，并没有指到 `~/.agents/skills` 的软链接；skill 是从 `~/.agents/skills` 被扫描到的。装新 skill 一律放 `~/.agents/skills/`。
