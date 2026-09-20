---
name: chrome-cdp-drive
description: 用户让操作/驱动本机浏览器时必读。触发场景:「打开某个网页」「读一下这个页面有什么」「帮我点 X 按钮」「操作浏览器」「在这个页签上……」「帮我上传文件 / 上传没反应 / 传不上去」「往网页编辑器里写文案 / 写不进正文 / 文字插到中间了」「加 #话题 / @某人 的联想面板不弹」「按钮点不到(元素在 shadow DOM 里)」「把这段 HTML 渲染成图 / 帮我截个图」;新机器或换人接手时也要先照 §0 搭环境。**同时支持 Windows 和 macOS**,第一件事是先判断平台(§0)。覆盖:环境搭建(自动探测 Chrome/Edge)、连接检查与自动恢复、取目标页签、访问页面、读取内容、点击元素(含"点到外层容器""元素在 closed shadow root 里"两个坑)、往富文本/contenteditable 里写文案(光标位置、联想面板、受控输入)、上传本地文件的三条路、截图与渲染本地 HTML 成图、弹窗与验证码处理。配脚本在 scripts/ 目录(node 内置 WebSocket,零依赖,跨平台)。
---

# 驱动浏览器(访问页面 + 点击操作)

## ★ 核心目标:一个浏览器,不是两个

**用户日常浏览用的那个浏览器,和被我驱动的那个浏览器,必须是同一个 —— 同一个程序、同一个 profile、同一份登录态。**

这不是"可选优化",这是这套东西存在的意义。由此推出三条硬规则:

1. **绝不另建一个"自动化专用浏览器"。** 用户已经在日常浏览器里登录好了一切;再开一个独立 profile,就等于所有站点都要重新登录一遍 —— 那是退化,不是隔离。历史上 macOS 版为此搞过"另建 `~/.chrome-automation` + 符号链接",**在两端都不需要也不该照搬**。
2. **绝不因为"要开调试端口"而反复问用户。** 启动脚本自己会处理(见 §0),直接调用它就行。**不要再问"要不要用 Edge""要不要共享 profile""能不能重启浏览器"这类问题。**
3. **日常启动入口就是这个脚本。** 用户点任务栏图标/Dock 起的浏览器没有调试端口,那才是"两个浏览器"的根源。

**任何站点都能访问、读取、点击,且登录态与用户平常浏览的完全是同一份。**

## 0. 第一件事:判断平台

```bash
uname -s 2>/dev/null || node -e 'console.log(process.platform)'
```
`MINGW*` / `MSYS*` / `CYGWIN*` / `win32` → **Windows**(下文 §0-Win);`Darwin` / `darwin` → **macOS**(§0-Mac)。

两端**唯一**要记住的差异:

| | Windows | macOS |
|---|---|---|
| 启动器 | `scripts/launch-windows.bat` | `scripts/launch-macos.sh` |
| 进程名(探测/杀) | `chrome.exe` / `msedge.exe`(taskkill) | `Google Chrome` / `Microsoft Edge`(pgrep/pkill) |
| 默认 profile | `%LocalAppData%\Microsoft\Edge\User Data` | `~/Library/Application Support/Microsoft Edge` |
| 浏览器位置 | `C:\Program Files (x86)\…` | `/Applications/….app/Contents/MacOS/…` |
| 解析 JSON | **只能用 node**(无 python3) | python3 或 node 都行(node 更稳) |
| `--headless` | **可用**(实测 Edge 137) | **坏的**(见 §3.5) |
| 出图路径 | `C:/…`(写 `/tmp` 会落到 `C:\tmp`) | `/tmp/…` 可用 |

**§1 之后的章节(取页签、六个脚本、操作流程、定位铁律)两端完全通用。**

## 0-Win. Windows 环境

**前提**:装 Edge(系统自带)或 Chrome;node v21+(脚本用内置 WebSocket,无需 playwright / npm install)。

**启动器**:`scripts\launch-windows.bat`(自动探测 + 自动恢复),已就位。核心内容:

```bat
set "PORT=9222"
if exist "%CHROME_A%" set "BROWSER=%CHROME_A%" & set "PROFILE=%LocalAppData%\Google\Chrome\User Data" & set "PROC=chrome.exe" & goto :have_browser
if exist "%EDGE_B%"  set "BROWSER=%EDGE_B%"  & set "PROFILE=%LocalAppData%\Microsoft\Edge\User Data" & set "PROC=msedge.exe" & goto :have_browser

:have_browser
"%SystemRoot%\System32\curl.exe" -s --max-time 2 http://127.0.0.1:%PORT%/json/version >nul 2>&1
if not errorlevel 1 ( start "" "%BROWSER%" --user-data-dir="%PROFILE%" --remote-debugging-port=%PORT% %* & goto :done )
tasklist /FI "IMAGENAME eq %PROC%" 2>nul | "%SystemRoot%\System32\find.exe" /I "%PROC%" >nul
if not errorlevel 1 (
  echo [warn] %PROC% is running WITHOUT a debug port. Restarting it.
  taskkill /F /IM %PROC% >nul 2>&1
  "%SystemRoot%\System32\ping.exe" -n 4 127.0.0.1 >nul
)
start "" "%BROWSER%" --user-data-dir="%PROFILE%" --remote-debugging-port=%PORT% --no-first-run --no-default-browser-check %*
:done
```

Windows 专属注意点(改脚本前先读):

- **`.bat` 里绝不能写中文注释。** cmd.exe 按 OEM 代码页(中文系统=GBK)解析 .bat,而文件是 UTF-8,中文注释会变乱码并报 `'xxx' 不是内部或外部命令`。**注解一律 ASCII。**
- **`curl` 要用 `%SystemRoot%\System32\curl.exe` 全路径** —— 装了 Git 的机器上,Git 的 curl 常排在系统 curl 前面,写裸 `curl` 解析到哪个不确定。
- **不要用 `timeout`**(无控制台时报错),用 `ping -n N 127.0.0.1` 当 sleep。
- **`taskkill /IM` 按进程名杀,会杀掉该浏览器的所有实例** —— 包括跑在别的 profile 上的隔离实例。有隔离实例在跑时,改用 CDP 的 `Browser.close`。
- **`%ProgramFiles(x86)%` 的括号会破坏 `if (...)` 块**,所以候选路径一律在块外先赋给变量。

## 0-Mac. macOS 环境

**前提**:装 Chrome 或 Edge(官网版,非 Chromium);node v21+。

**启动器**:`scripts/launch-macos.sh`,已就位。核心内容:

```bash
CANDIDATES=(
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome|$HOME/Library/Application Support/Google/Chrome|Google Chrome"
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge|$HOME/Library/Application Support/Microsoft Edge|Microsoft Edge"
)
for c in "${CANDIDATES[@]}"; do
  IFS='|' read -r exe prof pname <<< "$c"
  [ -x "$exe" ] && { BROWSER="$exe"; PROFILE="$prof"; PROC="$pname"; break; }
done

if curl -s --max-time 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
  launch "$@"; exit 0                                    # 分支 1:端口已开
fi
if pgrep -x "$PROC" >/dev/null 2>&1; then                # 分支 2:开着没端口
  echo "[warn] $PROC is running WITHOUT a debug port. Restarting it."
  pkill -x "$PROC"; for _ in $(seq 1 20); do pgrep -x "$PROC" >/dev/null 2>&1 || break; sleep 0.5; done
  pgrep -x "$PROC" >/dev/null 2>&1 && { pkill -9 -x "$PROC"; sleep 2; }
fi
launch --no-first-run --no-default-browser-check "$@"    # 分支 3
```

macOS 专属注意点:

- **用 `pgrep -x` / `pkill -x`(精确进程名)**,不要用 `pkill -f` —— `-f` 匹配完整命令行,会连 `Google Chrome Helper` 等辅助进程一起命中。`-x "Google Chrome"` 只匹配主进程。
- **launch 必须 `nohup … >/dev/null 2>&1 &` 再 `disown`。** 不重定向的话,浏览器会继承调用方的 stdout/管道,`./launch-macos.sh | tail` 这种写法会永久挂住。
- 启动脚本路径别用 `&!`(那是 zsh 专有);脚本用 `#!/bin/bash` 写,`nohup + disown` 两端都成立。
- 旧文档里那套 "`~/.chrome-automation-launch.sh` + `~/.zshrc` 里加 `chrome()` 函数" 仍然可用,但**不是必须的**;启动器就在 skill 里,别再把逻辑复制到 home 目录(两份逻辑必然分叉)。

## 0.9 两端共同点

- **profile 用浏览器自己的默认目录**,不新建目录 —— 这就是"打通"的实现方式,登录态天然共享。
- **`--user-data-dir` 必须显式传,但值就是默认路径本身。** 这点反直觉,值得说清:Chrome/Edge 136+ 的报错文案是 `DevTools remote debugging requires a non-default data directory`,容易让人以为"必须另建目录"。**实测不是** —— 它检查的是**有没有显式传这个参数**。显式指向默认路径,调试口照常打开(两端同样)。**所以既拿到了端口,又不用搬 profile 目录。**
- **端口只由"第一个启动的实例"提供。** 已经开着(无端口)时再跑启动器,只会让已有实例开个新窗口 —— 所以启动器必须先杀掉重启(分支 2),没有别的办法。
- 启动器支持 `CDP_PORT` / `CDP_PROFILE` 环境变量覆盖,隔离模式就靠这两个(windows 用 `set`,macos 直接前置)。

### ⚠️ 唯一会打断用户的情况,以及为什么不该问

分支 2 会**自动杀掉用户的浏览器并带端口重启**,所有窗口关闭(浏览器重开一般会恢复标签页)。**这是设计好的行为,不要为此征求同意** —— 端口只能由第一个实例提供,不存在"既保留旧实例又拿到端口"的办法;反复询问恰恰是本 skill 要消灭的东西。启动器自己会打 `[warn] … Restarting it.` 说明。

**唯一例外**:用户明说"我正开着 XX 别关" → 改用隔离模式(§0.95)。

### 0.95 隔离模式(仅当用户明确要求"独立/隔离/别动我的窗口"时)

**默认永远不要用** —— 它违背 §★ 的核心目标(登录态不共享)。只在用户明确要求时:

```bash
# Windows
set CDP_PORT=9223 & set CDP_PROFILE=C:\Users\me\.browser-isolated & launch-windows.bat https://example.com
# macOS
CDP_PORT=9223 CDP_PROFILE="$HOME/.browser-isolated" ./launch-macos.sh https://example.com
```

- **登录态不继承日常**,需登录的站点要在这个窗口单独登录一次(之后持久保留在隔离 profile 里)。
- **可以和日常实例同时跑、互不冲突**(不同 profile = 不同进程),这是它唯一的优势:不用打断用户。
- 取页签走 9223 的 `/json`;`cdp-render.mjs` 给 `CDP_PORT=9223`。
- **Windows 上别用 `taskkill /IM` 关它**(会连日常一起杀);用 CDP 的 `Browser.close` 精确关闭。
- 想要"每次全新、不留任何东西"→ `CDP_PROFILE` 指到临时目录(更干净,但不保留登录)。

## 1. 会话前必查调试口(连不上就自己修,不要问)

```bash
curl -s --max-time 2 http://127.0.0.1:9222/json/version
```
- **端口在** → 直接继续。
- **端口不在** → 直接跑启动器,它自己判断是"没开"还是"开着但没端口"并处理:

```bash
# Windows
cmd //c "%USERPROFILE%\\.claude\\skills\\chrome-cdp-drive\\scripts\\launch-windows.bat"
# macOS
"$HOME/.claude/skills/chrome-cdp-drive/scripts/launch-macos.sh"
# 等 3~5s 后复查
curl -s --max-time 2 http://127.0.0.1:9222/json/version
```

返回体形如 `{"Browser": "Edg/137.0.3296.68", …}`(`Edg/` = Edge,`Chrome/` = Chrome)。

**⚠️ 别把启动器的输出接管道。** `… | tail` 会在两端都**永久挂住** —— 浏览器进程继承了管道写端且不关闭,`tail` 一直等 EOF。要留输出就重定向到文件(`> log.txt 2>&1`)。

**不要再问用户"可以重启浏览器吗"** —— 启动器会打 `[warn] Restarting it.` 告知发生了什么,这就是全部交代。

## 2. 取目标页签 websocket

```bash
WS=$(curl -s http://127.0.0.1:9222/json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s).find(x=>x.type==="page"&&x.url.includes("example.com"));console.log(t?t.webSocketDebuggerUrl:"")})')
echo "$WS"   # 空 = 没匹配到页签
```
**统一用 node 解析**,不要用 python3 —— Windows 上没有,而且 node 是脚本本就依赖的,macOS 也一定有。把 `example.com` 换成目标站点关键字;多页签同名时先打印 `title/url/id` 清单再挑。

- **新开标签页**(HTTP API,不进 ws)。新版 Chrome/Edge 的 `/json/new` 和 `/json/close` **必须用 PUT**(GET 会被拒:"supports only PUT verb"):
  ```bash
  curl -s -X PUT "http://127.0.0.1:9222/json/new?$(node -e 'console.log(encodeURIComponent(process.argv[1]))' 'https://example.com')"
  # 返回体里有 id 和 webSocketDebuggerUrl;用完可 curl -s -X PUT "http://127.0.0.1:9222/json/close/<id>"
  ```
- **本地文件 URL 用 `file:///C:/…`(三个斜杠)**:写成 `file://C:\…` 打不开。

### Windows 专属坑:MSYS 会改写参数里的绝对路径

Git Bash(MSYS2)会把**看起来像 Unix 绝对路径的参数**自动改写成 Windows 路径。它连 JS 表达式里的字符串都改(实测):

```bash
CDP_EXPR='"/div"'              # 到达页面时变成了 "C:/Program Files/Git/div"
CDP_EXPR='/你好/.source'       # ✗ SyntaxError —— 正则字面量被改写
MSYS_NO_PATHCONV=1 CDP_EXPR='/你好/.source'   # ✓ 正常
```

**只要表达式里含 `/` 开头的字符串或正则字面量,就加 `MSYS_NO_PATHCONV=1` 前缀。**(`MSYS2_ARG_CONV_EXCL='*'` 对 env 变量**无效**,实测确认。)macOS 无此问题。

## 3. 八个脚本(env 传参,输出 JSON)

脚本目录:本 skill 的 `scripts/`。两端通用,**无任何平台相关代码**(纯 CDP + node stdlib,临时目录用 `os.tmpdir()` 自适应)。

| 脚本 | 作用 | 用法 |
|---|---|---|
| `cdp-eval.mjs` | 在页面执行任意 JS | `CDP_WS=… CDP_EXPR='<js>' node scripts/cdp-eval.mjs` |
| `cdp-nav.mjs` | 当前页签导航到 URL | `CDP_WS=… CDP_URL='https://…' node scripts/cdp-nav.mjs` |
| `cdp-click.mjs` | **真实鼠标点击**元素(trusted) | `CDP_WS=… CDP_FIND='<js 返回元素>' [CDP_AFTER=..] [CDP_SHOT=..] node scripts/cdp-click.mjs` |
| `cdp-type.mjs` | 聚焦元素并真实输入文本 | `CDP_WS=… CDP_FIND='<js 返回元素>' CDP_TEXT='文字' [CDP_ENTER=1] node scripts/cdp-type.mjs` |
| `cdp-shot.mjs` | 截图 | `CDP_WS=… [CDP_NAV=url] [CDP_OUT=<out.png>] [CDP_FULL=true] node scripts/cdp-shot.mjs` |
| `cdp-render.mjs` | 渲染本地 HTML/网址成 PNG(临时标签页,截完即关) | `node scripts/cdp-render.mjs <fileOrUrl> <out.png> [宽=1400] [高=720] [缩放=2]` |
| `cdp-keys.mjs` | **不聚焦、不点击**地发真实按键 / 插入文本,可先把光标摆到指定元素的末尾或全选 —— 富文本编辑器写字用它,不要用 cdp-type | `CDP_WS=… [CDP_FIND='<js 回到元素>'] [CDP_SEL_END='<选择器>'] [CDP_SEL_ALL='<选择器>'] [CDP_KEYS='meta+a,Backspace'] [CDP_TEXT='文字'] [CDP_TYPE='#话题'] node scripts/cdp-keys.mjs` |
| `upload-via-native-dialog.mjs` | **最后手段**(macOS,不稳):走系统文件对话框送路径。上传文件先试 §5.6 的前两条路 | `CDP_WS=… node scripts/upload-via-native-dialog.mjs --ws "$CDP_WS" --file /abs/a.mp4 [--find '<js>'] [--verify '<js 返回 true>']` |

脚本会先等页面 readyState=complete(限时 15~20s),截图我(Claude)能直接 Read 查看。**输出路径**:macOS 用 `/tmp/x.png`,Windows 用 `C:/Users/<你>/AppData/Local/Temp/x.png`(写 `/tmp` 会落到 `C:\tmp`)。不传 `CDP_OUT` 时落在系统临时目录。

## 3.5 渲染 HTML 成图

**首选永远是 `cdp-render.mjs`**,三个理由(两端成立):

1. **登录态**:它借的是**用户正在用的那个日常 profile**,登录态现成;`--headless` 起的是全新临时 profile,需登录的页面拿不到 cookie;
2. **像素精确**:走 `Emulation.setDeviceMetricsOverride`,最终像素 = CSS 尺寸 × 缩放,可控可复现;`--headless` 的 `--window-size` 不含缩放因子,高分屏下偏小;
3. **不留垃圾**:临时标签页 `PUT /json/new` → 截图 → `PUT /json/close`,不污染用户正在看的窗口。

```bash
node scripts/cdp-render.mjs "file:///C:/Users/<你>/AppData/Local/Temp/x.html" "C:/Users/<你>/AppData/Local/Temp/x.png" 1400 720 2
CDP_PORT=9223 node scripts/cdp-render.mjs …   # 换隔离实例
```

**`--headless` 的可用性两端相反**(万一必须用):

- **Windows:可用。** 实测 Edge 137 `--headless=new --screenshot` 正常出图(末行 `NNNN bytes written to file`);会打 `EDGE_IDENTITY` / `QQBrowser user data path not found` 两条无害噪音。
- **macOS:坏的。** `--headless=new/old` 都会崩(`CVDisplayLinkCreateWithCGDisplay failed`、`Assertion failed: (NULL == _txn) … NSCGSTransaction`)且**不产出文件** —— 只有 exit code 骗人。**跑完先 `ls` 确认文件真的存在,别信"命令没报错"。**

**尺寸按 1280 取舍**:很多站点(如飞书)上传图片时会把图压到 **1280px 宽**,所以本地渲染得比 1280 宽才有意义(常见做法:1400×720 @2x → 2800×1440)。整屏截图里的小字被压缩后看不清时,补一张"裁切放大"的局部图。

**别用 `captureBeyondViewport` 判断布局**:整页截图会临时改视口触发 reflow,长文会挤成一窄列,看着像"页面/文档坏了"。判断布局用普通视口截图 + `getBoundingClientRect`;整页截图只用来看全貌。

## 4. 标准操作流程
1. 查端口 → 取目标页 ws;
2. **先 dump 后动手**:用 `cdp-eval` 把含目标文案的所有元素(tag/class/尺寸/可见)打出来,看清按钮是 DIV 还是 `<button>`、有没有隐藏副本(桌面版 vs 移动端);
3. 访问:新页面用 `cdp-nav` 或 `json/new`;读内容用 `cdp-eval` 拼 JS(注意跨 iframe 的内容在 iframe 内取);
4. 点击:用 `cdp-click` 的 `CDP_FIND`,按「文本精确 + 可见」三连;
5. 读效果:`cdp-eval` 读状态 + `cdp-shot` 截图给用户看。
6. **动作后先等,再判断**:菜单、新标签页、对话框、上传这类操作常有 1~2s 延迟。做完立刻断言"没生效"会引发重复点击,而重复点击可能点到别的东西(弹层、悬浮按钮、别的页签)。固定节奏:**动作 → 等 1~2s → 截图 + 读状态 → 再决定要不要重试**,重试前先看一眼当前界面到底在什么状态。
   - 别拿固定等待时长兜底:弹层有没有就绪要看**坐标**(见 §5"停靠副本"那条),等 1~2s 看不到只是提示"再查一次",不是判据;
   - 截图偶尔会截到**上一帧的残留合成**:弹出对话框的同时还叠着刚关掉的菜单。同一位置隔 2s 再截一次再下判断,别据此以为"点错了、叠了两层"。

## 5. CDP_FIND 定位铁律(血泪)

- **必须取面积最小的叶子元素**,否则会点到外层容器(整页 div 的 textContent 也包含目标文字)。`CDP_FIND` 返回 null 时会明确报"元素未找到"。模板:
  ```js
  (() => { const rc=(e)=>e.getBoundingClientRect();
    const size=(e)=>{const r=rc(e);return r.width>10&&r.height>10;};
    // 屏幕外常藏着同一份元素的副本,尺寸是满的,点它=静默失败(见下条)
    const inview=(e)=>{const r=rc(e);return r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1;};
    const pick=(f)=>{const c=[...document.querySelectorAll('div,button,[role="button"],span,a')]
        .filter(x=>size(x)&&f(x)&&(x.textContent||'').trim()==='知道了');   // 文本用 === 精确匹配
      return c.sort((a,b)=>{const ra=rc(a),rb=rc(b);return (ra.width*ra.height)-(rb.width*rb.height);})[0]||null;};
    return pick(inview)||pick(e=>{const r=rc(e);return r.left>=0&&r.top>=0;});   // 退回"坐标非负"(目标在折叠线以下);绝不回退到 -9994 那种停靠元素
  })()
  ```
- 旧模板(仅尺寸过滤,留作对照):
  ```js
  (() => { const v=(e)=>{const r=e.getBoundingClientRect();return r.width>10&&r.height>10;};
    const c=[...document.querySelectorAll('div,button,[role="button"],span,a')]
      .filter(x=>{const t=(x.textContent||'').trim();return v(x)&&t==='知道了';});   // 文本用 === 精确匹配
    const e=c.sort((a,b)=>{const ra=a.getBoundingClientRect(),rb=b.getBoundingClientRect();return (ra.width*ra.height)-(rb.width*rb.height);})[0];
    return e||null; })()
  ```
- **引号规则(bash/zsh 通用,两端一样)**:外层一律用**单引号** `CDP_FIND='…'`。单引号内 shell **不做任何转义**,内容原样交给 node。因此 JS 里的双引号**照原样写**,只有把 `\"` 写在 **JS 字符串外面**才炸:
  ```bash
  CDP_FIND='document.querySelectorAll("div,button,[role=\"button\"],span,a").length'  # ✓
  CDP_FIND='[...document.querySelectorAll("div,button")]'                             # ✓ 裸双引号
  CDP_FIND='\"literal\"'                                                              # ✗ SyntaxError(JS 字符串外)
  ```
  第一条里的 `\"` 是 **JS 的**转义(处在 JS 字符串内部),不是 shell 的 —— 这正是 `[role="button"]` 这种带引号选择器的正确写法。
  表达式长、或需同时含单双引号时,写进 `find.js`,用 `CDP_FIND="$(cat find.js)"` 传最省心。
  **Windows 上另需注意 §2 的 `MSYS_NO_PATHCONV=1`(含 `/` 开头的字符串/正则时)。**
- 按钮常是 **DIV 不是 `<button>`**(如 uutix 的 `detail-subscribe-button`),选择器要覆盖 `div,button,[role="button"]`;
- **元素"看得见、查不到" → 先怀疑 closed shadow root**:页面上明明画着按钮,但 `querySelectorAll` 一个都匹配不到、`elementFromPoint` 只返回一个**大块宿主元素**、宿主的 `innerHTML` 还是空的、`.shadowRoot` 是 `null`(closed 模式拿不到)—— 这就是自定义元素里的 closed shadow DOM(实测小红书底部那排 `暂存离开`/`发布` 就在 `<xhs-publish-btn>` 里)。两条出路:
  - **穿透查询**(首选,能拿到语义和坐标):`DOM.getDocument({depth:-1, pierce:true})` 会把 `shadowRoots` 一起返回,再用 `DOM.getBoxModel` 取中心 + `Input.dispatchMouseEvent` 发真实鼠标事件。**nodeId 只在单个 CDP 会话内有效**,取节点、取坐标、点击必须写在一个脚本里。现成实现:skill **xiaohongshu-publish** 的 `scripts/xhs-el.mjs`(按文本找/点,能穿 closed shadow root;实测能查到并能点中 closed shadow 里的按钮),自己写别的站点时照它的结构抄;
  - 退而求其次用**坐标点击**:`elementFromPoint` 拿到的宿主框还在,按它算出按钮大致位置直接发鼠标事件(视觉定位更脆弱,文案/布局一变就偏)。
- 同一文案多个实例:过滤 `width>10 && height>10` 只挡掉隐藏/移动端副本,**不够** —— 弹层项在"没展开/没定位好"时会**停靠在屏幕外的固定坐标**,尺寸却是满的(飞书云盘首页「新建」菜单的 11 个 `li.ud__menu-item` 就在 `x≈-9994, y≈-9995`,262×40),尺寸过滤照样放行。**判据是坐标,不是等待时长**:就绪后同一个元素在 `x≈297`(同一页签里实测有的 2s 到位、有的 3.5s 还停靠着),所以优先取"在视口内"的候选,取不到就说明弹层还没就绪。
- **点到停靠副本的后果是"静默失败 + 把现场弄乱"**:`cdp-click` 点前会 `scrollIntoView({block:'center'})`,在停靠副本上等于先滚动最近的滚动容器、再按负坐标空点一发(实测 `x=-9932, y=-9975`);在弹层场景里这一下会被当成"点在弹层外面",**直接把菜单关掉**。症状是"点了完全没反应、菜单还自己收起来了"——先怀疑这条,而不是怀疑选择器写错。做法:点之前先 dump 一次目标坐标,**是负数就先别点**——`Page.bringToFront` 或关掉再重新点开弹层,重读坐标变正再点。
- **能用元素定位就别用坐标点击**:直接 `Input.dispatchMouseEvent` 打坐标没有语义保证,页面右下角的悬浮按钮(AI 助手、帮助、回到顶部)最容易被误点,一旦点开会抢焦点并改变布局,后面一串操作全乱。没有可定位元素时,优先用键盘(cdp-type 的 `CDP_ENTER=1`),最后才用坐标;
- 填 Vue/React 输入框:优先用 `cdp-type.mjs`(走 `Input.insertText`,真实输入,框架能感知)。若需 JS 赋值则用 `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set` + 派发 `input` 事件,否则框架感知不到;
- 页面内联动(选中票档后按钮才激活):点完等 1~2s 再点下一步;
- 点完没反应(没跳转/没弹窗):换 `el.click()`(部分站点 Input 事件不触发,反之亦然),两招都试。

## 5.5 往页面里写文案(contenteditable / 受控输入 / 联想面板)

**症状**:多行富文本里插进去的文字落在**句子中间**而不是末尾;`#话题` chip 后面多出一个尾字;打了 `#` 联想面板不弹。

**根因 1(最容易中的)**:`cdp-type.mjs` 为了激活 contenteditable 会**在元素中心打一次真实鼠标点击**——那一下就把光标挪到了正文中间。短输入框看不出来,长文案/多行编辑器必翻车(实测往抖音描述里插 `任务管理`,落点变成了"被消息反复**任务管理**打断之后")。

**正确做法:富文本一律用 `cdp-keys.mjs`(不聚焦、不点击)**,三种模式按需组合:
```bash
# 追加到末尾:先把选区收拢到该元素内容末尾,再插文本
CDP_WS="$WS" CDP_SEL_END='div.tiptap[contenteditable=true]' CDP_TEXT="$(cat 文案.txt)" node scripts/cdp-keys.mjs
# 整体替换:全选 → Backspace → 写新的
CDP_WS="$WS" CDP_SEL_ALL='div.tiptap[contenteditable=true]' CDP_KEYS='Backspace' CDP_TEXT="$(cat 新文案.txt)" node scripts/cdp-keys.mjs
# 触发联想/话题面板:必须逐字符真实按键
CDP_WS="$WS" CDP_SEL_END='div.tiptap[contenteditable=true]' CDP_TYPE=$'\n#任务管理' node scripts/cdp-keys.mjs
```

- **根因 2:联想面板只认真实按键。** 用 `Input.insertText` 一次性插入 `#关键词`,编辑器的"联想范围"会算歪,选中后生成的 chip **会多一个尾字**(实测小红书:`#任务管理` → chip 文本变成 `#任务管理 理`,`#效率工具` → `#效率工具 具`)。改成 `CDP_TYPE`(逐字符 keyDown+keyUp)后 chip 干净。同理,`#`/`@` 起头的输入别用 TEXT。
- **别用 execCommand 反复改同一段。** 受控富文本会把程序化二次编辑回写(实测"全选→删→重新 insertText"会把开头几个字复制一遍)。要改就用真实按键整体重做。
- **换行会被压。** `Input.insertText` 塞的 `\n\n` 在有些编辑器里渲染成单个换行——别指望空行做视觉分段。
- **受控输入框(React/Vue 的标题框)**:用原生 setter 赋值 + 派发 `input`/`change`,否则框架感知不到(写法见各发布 skill)。
- **写完必须回读校验**,不要"发完命令就当成了":
  - 文本:`document.querySelector('…[contenteditable]').innerText`;
  - 话题 chip 数量:抖音 `editor.querySelectorAll("[data-mention]").length`、小红书 `a.tiptap-topic`;
  - 字数:`21/30`、`176 / 1000` 这类计数器(注意有的带空格)。
  - 小红书 chip 的 `innerText` 里会带 `[话题]#`(那是 `<span class="content-hide">` 隐藏文本),**它不是脏字符**;要看的是 chip 名字后面有没有多出来的那一个字。

## 5.6 上传本地文件:三条路,按代价从小到大

1. **直接塞**:`DOM.setFileInputFiles`。页面常有两个 `input[type=file]`(**视频 / 图片**分开,别塞错 index)。注意:塞对了 **`files.length` 也可能立刻回 0**(框架读完文件会清空 input),所以**判据不是 `files.length`,而是"页面有没有进入下一步"**。现成脚本:各发布 skill 里的 `set-file-input.mjs`。
2. **拦截文件选择框**:`Page.setInterceptFileChooserDialog` → 真实点击触发 → 等 `Page.fileChooserOpened` 拿 `backendNodeId` → `DOM.setFileInputFiles({backendNodeId})`。适合"要求真实用户手势、直接塞会被清空"的组件。现成脚本:`kuaishou-publish/scripts/upload-via-file-chooser.mjs`。
3. **系统文件对话框 + AppleScript(最后手段,仅 macOS,且不稳)**:见 `scripts/upload-via-native-dialog.mjs`。实测快手**视频**上传页连第 2 条都不认:返回成功、`files.length` 回 0、**Network 域里一条上传请求都没有**(所以别把"没报错"当"上传中",要开 Network 域看)。真要试这条路,先读脚本头部注的四个坑(必须 `tell process`;别碰 `text field 1`,那是**搜索栏**,会把后续 `Cmd+Shift+G` 吃掉;`Esc` 是验键盘通道的探针;sheet 未必挂在 `window 1`)。**失败就停手,让用户自己手动选文件**,别反复重试抢前台焦点。

- **无论哪条路,都要用页面状态验证**:视频看 `document.querySelector('video')` 的 `duration/videoWidth`(和源文件对得上才算),图片看提示语/缩略图,表单看是否出现"下一步"。**没验证 = 没成功。**
- 中文文件名/路径先复制成 ASCII 路径(`/tmp/x.mp4`)再操作,省掉输入法和转义的问题。

## 6. 边界:这几类动作仍然要停下来
上面说"不要反复确认"指的是**环境/连接层面**的事(用哪个浏览器、要不要重启、要不要共享 profile)。下面这几类是**有实际后果**的动作,仍然先截图告诉用户、等用户决定:

- **确认/购买/支付类弹窗**(涉及钱);
- **滑块验证 / 拖动拼图**(腾讯等):不要自动解(反爬安全机制),提示用户手动拖,拖完再继续;
- **发送消息给真人 / 公开发布**(发帖、发评论、发消息给联系人)—— 发给 AI 聊天机器人、填表单查数据这类不算;
- 广告/浮层异步加载挡按钮:轮询点掉 `.advert-modal-close` 一类关闭元素(这个可以直接做)。

## 7. 参考
- 「按钮点不到/页面自动关闭(TargetClosedError)/单账号单购物车/风控冷却」等踩坑 → skill **web-automation-dom-cdp**;
- 「接口签名/设备指纹/反爬重放被拒」→ skill **anti-crawl-api-reverse**;
- 「发抖音/快手/小红书的图文或视频」的具体流程(入口、字段、封面、发布按钮、发布后怎么验证)→ skill **douyin-publish** / **kuaishou-publish** / **xiaohongshu-publish**;
- 站内弹验证时 uutix 这类站点可能对"复制 profile"识别为新设备而触发验证,属正常。
