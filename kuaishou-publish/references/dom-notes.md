# DOM 细节与实测记录（2026-09-14 / 15 实测）

快手创作平台前端会改版，这里的值用于出问题时定位，不要当成硬约束。

## 上传页

入口 `https://cp.kuaishou.com/article/publish/video?origin=www.kuaishou.com&source=NewReco`。

- 顶部 tab：`上传视频` / `上传图文` / `上传全景视频`，DOM 是 `.ant-tabs-tab` + `.ant-tabs-tab-btn`，当前项多一个 `ant-tabs-tab-active`。
- **URL 写的是 `/publish/video`，但新开页签默认停在「上传视频」**；必须点 `上传图文`。已经在图文页的旧页签会记住，别拿旧页签的行为推断新页签。
- 图文上传区：`拖拽图片到此或点击上传` + 红色 `上传图片` 按钮；规格文案「支持最多31张，最大15MB的图片文件」「支持常见图片格式，支持png、jpg、jpeg、webp，不支持gif、livp」「推荐上传宽高比为3:4的竖版图片」。
- **2 个 `input[type=file]`**：

  | index | accept | multiple |
  |---|---|---|
  | 0 | `video/*,.mp4,.mov,.flv,...` | false |
  | 1 | `image/png, image/jpg, image/jpeg, image/webp` | true（`display:none;opacity:0;width:0`） |

### 上传为什么必须走「拦截文件选择框」（重点）

直接对 `[1]` 调 `DOM.setFileInputFiles`：调用不报错，脚本回读 `files.length` 是 **0**，页面完全没反应（仍是「拖拽图片到此或点击上传」）。同一套方法在闲鱼、抖音都能用，快手不行 —— 它的上传组件要求真实用户手势，并且会在自己一轮渲染里重置 input。

可行路径（`scripts/upload-via-file-chooser.mjs` 已实现，实测一次成功）：

1. `Page.enable` + `Page.setInterceptFileChooserDialog({enabled:true})`
2. `Input.dispatchMouseEvent` 在 `上传图片` 按钮上发真实 mousePressed/mouseReleased（坐标 812, 407 于 1440×669 视口）
3. 监听 `Page.fileChooserOpened` 事件，取 `backendNodeId`（实测拿到 866 / 129）
4. `DOM.setFileInputFiles({backendNodeId, files:[abs_path]})`

成功标志：整体切到「发布图文」表单，`编辑图片` 显示 `1/31`，右侧出现手机预览（`预览封面` / `预览作品` 两个 tab）。

## 发布图文表单

从上到下：`作品描述` → `活动推荐` → `封面设置` → `编辑图片` → `添加音乐` → `作者服务` → `作者声明` → `添加地点` → `发布设置` → `发布 / 取消`；右上是手机预览，右中是「发布助手 → 作品检测」。

| 用途 | 选择器 | 备注 |
|---|---|---|
| 作品描述 | `div[contenteditable=true]`（class `_description_eho7l_59`，哈希会变） | 上限 500，计数 `n/500`；**没有独立标题字段** |
| `@用户` / `#话题` | 文本精确的 `span`（`children.length===0`，约 54×28） | 点击后在光标处插 `#` |
| 话题联想面板 | class 含 `_desc-dropdown_` / `_dropdown-container_` | 列表项 class 含 `topic-item` |
| 话题 chip | `.at-tag-item`（外层 `span[is-tag="true"]`，内层带 `data-tag-name`） | 选中后插入编辑区 |
| 音乐搜索框 | `input[placeholder="搜索音乐"]`（class `_search-input_...`） | 抽屉里的那个 |
| 音乐列表项 | class 含 `_item_19mmt_90` | 每行两行文本：曲名+时长+作者 |
| 音乐「添加」按钮 | 行内 `div._button_3a3lq_1._button-primary_3a3lq_60`，文本 `添加`（75×36） | 点整行**不生效** |
| 发布按钮 | `div._button_3a3lq_1._button-primary_3a3lq_60`，文本 `发布`（96×36） | 普通 div，非 shadow DOM |
| 取消 | 同级 `_button-default_` | — |

默认值（实测）：封面「已使用默认封面」（第一张图）、作者服务/作者声明/添加地点为空、查看权限 `所有人可见`、发布时间 `立即发布`。

## 描述与话题

- 注入：`focus()` → Range 收拢到末尾 → `execCommand("insertText", false, text)` → 计数 `0/500` 变 `19/500`，2 秒后仍稳定（不像抖音那样会被框架回写）。
- 话题实测命中值：`#字幕`（5703.7w次播放）、`#双语字幕`（633.9w）、`#字幕制作`（335.7w）。搜「双语」和搜「双语字幕」出来的列表不同，**关键词要打全**。
- 加完 3 个话题后描述计数是 `38/500`（19 字正文 + 3 个话题共 19 个字符宽度）。
- `#` 插在**光标处**：加话题前必须先把光标放到描述末尾，否则会插进正文中间。

## 音乐

「作品检测」默认报 ⚠ `作品未添加音乐`，文案「图文作品添加音乐，可提高作品吸引力，获取更多流量曝光。」；加成功后变成 `作品已添加音乐`。

### 搜索框的坑

用 `Cmd+A → Backspace` 清不干净（实测关键词会叠成 `纯音10短音卡纯音乐`，搜索结果于是完全没有参考价值）。必须：

```js
const el = [...document.querySelectorAll('input')]
  .filter(e => (e.placeholder || '').includes('搜索音乐') && e.offsetParent !== null)[0];
Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '10秒');
el.dispatchEvent(new Event('input', { bubbles: true }));
```

### 抽屉可能在视口外

抽屉关闭时整块停在 `x=1440`（视口宽 1440），`querySelectorAll` 照样能拿到那些行，但 `Input.dispatchMouseEvent` 打在视口外=什么也没发生（实测踩过一次：点「添加」返回 `clicked x=1851`，音乐没变）。判断：行 `getBoundingClientRect().x` 应在 900~1400。

### 时长与曲库实测

加完音乐后 widget 只显示 `曲名 | 00:00 | 00:10 | 更换音乐 | 删除`，**没有裁剪/时长设置入口**，只能按曲库原长挑。搜索关键词 → 最短可得：

| 关键词 | 最短 | 说明 |
|---|---|---|
| `10秒` | **10 秒**（13 首，图虫） | 误解10秒 / 早鸟10秒 / 崇拜10秒 / 深情10秒 / 爱情10秒 / 晒太阳10秒 / 这样做10秒 / 月光下10秒 / 不在前10秒 / 硬推进10秒 / 总梦想10秒 / 辐射区10秒 / 阿惠海10秒 |
| `15秒` | 15 秒（图虫） | 15秒 / 猫15秒 / 玩15秒 … |
| `短音乐` | 18 秒 | 大展宏图-短音乐版（猴子音悦）；也有 3~4 秒的 `短音乐 钢琴 感动`、`短音乐 吉他 乡村`（提示音性质） |
| `纯音乐` | 28 秒 | 纯音乐（夏天）张鲜；其余 34 秒 ~ 4 分钟 |
| `轻音乐` | 25 秒 | 早安（轻音乐） |
| `背景音乐` | 17 秒 | 沉重背景音乐（曲风偏压抑，慎用） |

结论：图文要短音乐就搜 `10秒`。

## 发布结果

- 点「发布」后跳 `https://cp.kuaishou.com/article/manage/video?status=2&from=publish`（作品管理 → **待发布** tab）。
- 列表项显示「描述 + 话题」和状态 `审核中`，缩略图是上传的图片；点 `全部作品` tab 看总数与各条状态（实测发第二条后：`共2个作品`，一条 `已发布` 2026-09-15 00:01、一条 `审核中`）。
- 列表里**没有 `<a href>`、也没暴露作品 id** → 拿不到公网播放链接，只能让用户在 App 里分享。

## 环境备忘

- Chrome CDP 端口 9222；驱动方式见 skill **chrome-cdp-drive**。
- 本机 `~/.codex/skills` 只有 `.system`，并没有指到 `~/.agents/skills` 的软链接；skill 是从 `~/.agents/skills` 被扫描到的。装新 skill 一律放 `~/.agents/skills/`。
