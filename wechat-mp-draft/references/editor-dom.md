# 编辑器 DOM 与常见卡点(2026-09 实测)

公众号后台前端会改版,这里的选择器用于出问题时定位,不要当成硬约束;先 `node wx.mjs tabs` 看实际 URL,再用 `cdp-eval` dump 一次元素确认。

## 页签与 URL

- 列表页(草稿箱):`https://mp.weixin.qq.com/cgi-bin/appmsg?begin=0&count=10&type=77&action=list_card&token=…` → 特征串 `list_card`。
- 编辑器页:**新建时** `t=media/appmsg_edit_v2&action=edit&isNew=1&type=10&token=…`;**存过草稿后**浏览器地址变成 `t=media/appmsg_edit&action=edit&…&appmsgid=1000xxxxx&token=…`。两种都含 `appmsg_edit`,脚本按这个串找页签。
- **两个页签的 title 都是「公众号」**,`tabs` 里无法靠标题区分,只能看 URL。

## 新建一篇文章的点击链

1. 列表页右上角绿按钮「新的创作」——`BUTTON.weui-desktop-btn.weui-desktop-btn_primary`(同层还有 `文章 / 选择已有内容 / 贴图 / 视频 / 播客 / 转载` 的下拉项,别点错)。
2. 点完后弹出下拉菜单,**不是立刻开新页签**:菜单项文本在 `span.weui-desktop-dropdown__list-ele__text` 里,取它的 `closest('li,.weui-desktop-dropdown__list-ele')` 再点。
3. 点「文章」后才 `PUT /json/new` 出一个新编辑器页签(约 1~3s)。

点完「新的创作」立刻 `tabs` 很容易误判"没点中"而重复点击,重复点击可能点到菜单里别的东西。**约定:动作 → 等 1~2s → 截图复核 → 再决定重试。**

## 编辑器结构

微信这个图文编辑器是 ProseMirror,不是 UEditor 的 `<iframe>`:它套了 `.mock-iframe` / `.mock-iframe-document` / `.mock-iframe-body` 这层"假 iframe",但可编辑区就在主文档里,`cdp-eval` 直接能取到。

| 部位 | 选择器 |
| --- | --- |
| 正文可编辑区 | `.rich_media_content .ProseMirror`(父级 class 是 `view rich_media_content autoTypeSetting24psection`) |
| 标题可编辑区 | `.title-editor__input .ProseMirror`(空标题时的占位是「请在这里输入标题」) |
| 标题的表单镜像 | `textarea#title`(隐藏,提交用;写完可以读它复核) |
| 正文字数 | 底部 `正文字数 N`;标题上限 `0/64` |

正文里两个 `ProseMirror` 分别对应标题和正文,`document.querySelectorAll('.ProseMirror')` 会拿到多个,必须带上父级类名定位。

## 粘贴怎么写进去

**必须走系统剪贴板 + 真实 Cmd+V**,不要 `innerHTML` 注入或 `execCommand`——ProseMirror 有自己的文档状态,DOM 改动会被它覆盖回去。

1. `scripts/setclip.sh html <file>` 把 HTML 以 `text/html` flavor 写进剪贴板(用 osascript 的 `«class HTML»` 只会变成纯文本,把标签原样贴进去);
2. 真实点击正文把它激活(空文档时点一下正文区即可);
3. `Input.dispatchKeyEvent` 发 `meta+v`,**params 里要带 `commands:["Paste"]`**,裸按键事件不触发粘贴;`meta+a` 同理会带 `commands:["SelectAll"]`。

粘出来的块(实测):

- `<p>` → 段落;`<strong>` 保留为加粗(所以小标题用加粗段落)。
- `<ul><li>` → `ul.list-paddingleft-1` 列表,保留。
- 行内样式会被剥:粘 `<p style="text-align:center">` 后 DOM 里只剩 `<em>`/`<span leaf="">`,样式没了;要居中得用编辑器工具栏。
- 图片同样是剪贴板 + Cmd+V:PNG 放进剪贴板后粘贴,微信**立即上传**,`src` 从本地 blob 变成 `https://mmbiz.qpic.cn/mmbiz_png/…`;粘完等 4~6s 再查,否则会以为没进去。

### 光标行为(决定粘到哪)

- 粘完一段结构化 HTML 后,光标落在**文末**——实际落在 `.ProseMirror` 末尾那个零高的 `<section>` 里(`getSelection()` 的 anchorNode 是空 SPAN)。连续粘贴天然按顺序追加。
- 图片块是个 `<section>` 包 `<img>`,**里面放不了光标**;要在图片后面继续写,得点图片下方的空白,或者干脆靠"按顺序粘"(文本 → 图 → 文本)来保证位置。
- 要在中途插内容(比如补图注):先 `click <文本> start` 把光标点到目标段落开头,再粘——块级 HTML 粘进段落会把该段落切开,插在前面。
- 清空:`meta+a` 的选择范围**只在本编辑器内**(实测选中长度 ≈ 正文字数,标题不受影响),再 `delete` 即可。

## 保存

- 「保存为草稿」是右下角固定栏里的按钮(同级还有 `预览` / `发表`),取文本精确匹配、面积最小的那个元素点。
- 编辑器**自己也会自动存**(底部显示 `HH:MM 已保存`);点手动保存后,左侧「历史版本」会多一行 `日期 时间 … 手动保存`。
- 存过之后地址栏才会出现 `appmsgid`。

## 草稿箱列表怎么验收

列表卡片渲染在 **shadow DOM** 里:`document.querySelectorAll('*')` 找不到卡片元素,但 `document.body.innerText` 能看到渲染后的文本。所以 `drafts` 是解析 innerText:

```
… 文章 3 / 新的创作 / <标题> / 更新于 09:26 / <标题> / 更新于 … / 已加载全部内容
```

即「新的创作」之后按 (标题, 更新于 …) 成对读取。草稿数在 `文章 N` 里。

## 其他坑

- `PUT /json/new`、`PUT /json/close`:新版 Chrome 只认 PUT,GET 会被拒。
- `Network.getCookies` 只在 **page target** 上有;连浏览器级 `webSocketDebuggerUrl` 调会报 `-32601`。
- 想下载素材页里需要登录态的图(飞书文档等),用 `scripts/fetchimg.mjs`:取该页 cookie 后用 node fetch 拉原图,别把 base64 从浏览器里搬出来过 shell。

## 一键排版(articlestruct 页)

编辑器右下角「一键排版」(`.ailayout-btn_wrp`,edui 的 `edui-for-ailayout`)点下去**不在当前页开面板**,而是 `PUT /json/new` 开一个新页签:

```
https://mp.weixin.qq.com/cgi-bin/articlestruct?taskid=<id>&token=…
```

页面结构:

| 部位 | 选择器 |
| --- | --- |
| 样式列表 | `.layoutstyle_item`(第一个 = 默认「标准」`layoutstyle_item_standard`,默认就带 `selected`) |
| 主题色色块 | `.themecolor-item_wrp`(第一个默认选中,rgb(43,119,191)) |
| 应用按钮 | `.article_layout-save`,文案是「**使用此排版**」,不是「确定」 |
| 取消 | `.article_layout-cancel` |

点完「使用此排版」,**这个页签自己跳到编辑器**,URL 变成 `t=media/appmsg_edit&…&appmsgid=…&isFromLayout=1`,并且带着排版结果——排版是先存库、再由新页签重新加载的。所以排版之后该用哪个页签,见下节。

排版效果:正文每个 `<p>` 变成
`<section data-layout-id="N" style="font-size:17px;font-weight:400;color:rgba(0,0,0,0.9);line-height:1.8;margin-bottom:24px">`;
判断「排过没」看有没有 `[data-layout-id]` 就行。

### 页签会分裂,各自不同步(最容易踩的坑)

同一个草稿开两个编辑器页签,**它们是各自独立的内存状态**:

- 在 A 页签做的排版、原创声明,不会出现在本来就开着的 B 页签上;
- 在 B 页签点保存,会用它那份旧内容把草稿覆盖回去。

所以:**一键排版之后,后续操作一律用排版回来的那个新页签**。旧页签留着容易出事(别在它上面保存,用完直接关掉)。脚本里 `runFormat()` 会把 `last-editor.json` 指到新页签,后续命令自然跟过去。

同理,保存时弹出「当前编辑的草稿不是最新版本」,说明还有另一个页签存过更新版——先重载当前页签拿到最新内容,再继续。

## 声明原创

正文底部的「文章设置」区里,`#js_original` 那一组有两个块:

- 未声明:`.origined__area-new`(默认 `display:flex`),开关是 `.js_edit_ori`,文本「未声明」;
- 已声明:`#js_original_open` 的 `display` 变成非 `none`,里面 `.setting-group__switch-tips` 会拼成「文字原创 · 作者: 奉钦」。

**读状态别读 `#js_original` 的 `innerText`**:这块整体可能没被渲染,`innerText` 会退化成 `textContent`,把「未声明」和「已声明」两个块粘成一句话。按 `#js_original_open` 的 `display` 判。

弹窗(点 `.js_edit_ori` 打开):

| 部位 | 选择器 |
| --- | --- |
| 弹窗容器 | `.weui-desktop-dialog`(**必须先按可见性过滤**:页面里常驻几个隐藏弹窗,直接 `querySelector` 会取到「切换账号」「实名」「完善头像」那几个) |
| 声明类型 | `input.js_original_type_radio`,`value="0"` = 文字原创,`-1` = 无需声明,`1` 隐藏 |
| 作者 | `input.js_counter.js_author`(另一个 `.js_author` 属于赞赏账户,隐藏,别点错) |
| 协议勾选 | `input.weui-desktop-form__checkbox`(默认已勾) |
| 确定 / 取消 | `.weui-desktop-btn_primary` / `.weui-desktop-btn_default` |

**往输入框里写字必须逐字发真实按键**(`Input.dispatchKeyEvent`,type=`keyDown` 且带上 `text`)。`Input.insertText` 只改 DOM 的 value,Vue 的 `input` 事件收不到——现象是框里明明显示「奉钦」、右下角计数还是 `0/8`,点确定报「作者不能为空且不超过8个字」。

页面刚刷新完时点「未声明」可能没反应(前端还没初始化完),重试一次通常就好。
