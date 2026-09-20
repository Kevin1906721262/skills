# DOM 细节与实测记录（2026-09-14 实测）

抖音创作平台前端会改版，这里的值用于出问题时定位，不要当成硬约束。

## 上传页

入口 `https://creator.douyin.com/creator-micro/content/upload?enter_from=dou_web`，默认停在 `发布图文`。

- 顶部 tab：`发布视频 / 发布图文 / 发布全景视频 / 发布文章`（当前项有下划线）。
- 上传区文案：「点击上传 或 直接将图片文件拖动到此区域」「最多支持上传35张图片，图片格式不支持gif格式」，右侧有黑色 `上传图文` 按钮。
- **页面有 2 个 `input[type=file]`**：

  | index | accept | multiple |
  |---|---|---|
  | 0 | `video/x-flv,video/mp4,...,.mkv,.m4` | false（visible） |
  | 1 | `image/png,image/jpeg,image/jpg,image/bmp,image/webp,image/tif` | true（视觉上 1×1 隐藏） |

  只塞 `[1]`。塞完之后 `document.querySelectorAll("input[type=file]")[1]` 可能因为重渲染查不到（`filesAfter` 返回 null 不代表失败），看页面是否切到表单页为准。

## 作品发布表单

上传完成后整页变成表单（左：基础信息，右：手机预览「预览图文」）。

| 用途 | 选择器 | 备注 |
|---|---|---|
| 标题 | `input[placeholder="添加作品标题"]` | 上限 20，计数 `n/20`，React 受控 |
| 描述 | `div[contenteditable=true]` | 上限 1000，计数 `n / 1000`（带空格）；富文本，行结构是 `div.ace-line` |
| 添加话题按钮 | `div.toolbar-button-spPS4r`（文本 `#添加话题`） | 同行还有 `@好友`；按钮容器 `toolbar-comp-container-Zk3boM` |
| 话题联想面板 | `.mention-suggest-mount-dom` / `.mention-suggest-item-container-TVOZMl` | 每行两个子 div：`#话题名` 和热度值 |
| 话题 chip | `[data-mention]` | 选中后插入到编辑区，`data-fake-text` + `data-rect-container` |
| 发布按钮 | `button.button-dhlUZE.primary-cECiOJ.fixed-J9O8Yw` | 文本「发布」，120×32，黑色，底部固定栏 |
| 暂存离开 | 同上容器内的次级按钮 | 白底 |

发布设置（都是 radio，默认值实测）：`谁可以看`=公开、`保存权限`=允许、`发布时间`=立即发布。位置/关联热点默认为空，官方活动默认不勾，封面默认第一张图。

### 描述编辑器的两个坑（重点）

1. **受控富文本，程序化二次编辑会被回写**。实测：先用 `execCommand("insertText")` 注入文案（19 字，计数 19/1000 正确），随后「选中全部 → `execCommand("delete")` → 再 insertText」得到 21 字 —— 开头「可配」被复制了一遍（`可配可配字幕、…`）。补救办法是真实键盘：聚焦编辑区 → `Cmd+A` → `Backspace` → 重新输入。
2. **不要用键盘敲 `#` 起头做话题**。实测光标不在末尾时 `Input.insertText("#字幕")` 的结果是 `可配字可配字幕、双语字幕、字幕校准、字幕处理`（`#` 被联想逻辑吃掉、文本被插到中间）。正确路径是「把光标放末尾 → 点 `#添加话题` 按钮 → 输入关键词 → 点联想项」。点按钮时 `#` 会插在**光标处**，所以光标位置必须先摆好。

### 话题联想的实测数据

- 输入 `字幕` → 列表：`#字幕`(9.0亿)、`#字幕制作`(4682.3万)、`#字幕素材`、`#字幕组`、`#字幕搞笑视频`、`#字幕大灯`、`#字幕翻译`、`#字幕版`、`#字幕条`、`#字幕工厂`…
- 输入 `双语` → 列表里**没有** `#双语字幕`（只有 `#双语`、`#双语宝宝`、`#双语儿歌`、`#双语启蒙`）；补全成 `双语字幕` 后第一条就是 `#双语字幕`(1.3亿)。
- 结论：关键词打全，别停在半截就选近似话题。

## 发布结果

- 点「发布」后跳 `https://creator.douyin.com/creator-micro/content/manage?enter_from=publish`，并弹出「请问你对本次作品发布过程的满意度是?」表情问卷（**这不是成功证据**）。
- **列表是缓存的**：刚跳过去时 `作品 (28)`，列表第一条还是昨天那条，找不到自己的新作品。`location.reload()` 之后变成 `作品 (29)`，第一条即新作品：

  ```
  1张
  可配字幕、双语字幕、字幕校准、字幕处理。可配字幕、双语字幕、字幕校准、字幕处理 #字幕 #双语字幕 #字幕制作
  2026年09月14日 22:32   已发布
  播放 0  点赞 0  评论 0  分享 0  收藏 0  划走率 0%
  ```

  注意列表把「标题 + 描述 + 话题」拼成一行展示，所以看起来像文案重复了两遍。
- 作品卡片上没有 `<a href>`，DOM 里也没有作品 id —— 从内容管理页拿不到公开播放链接；要链接得点作品标题打开作品页（未验证会跳到哪里），或用手机分享。

## 环境备忘

- Chrome CDP 端口 9222；驱动方式见 skill **chrome-cdp-drive**。
- 本机 `~/.codex/skills` 只有 `.system`，并没有指到 `~/.agents/skills` 的软链接；skill 是从 `~/.agents/skills` 被扫描到的。装新 skill 一律放 `~/.agents/skills/`。
