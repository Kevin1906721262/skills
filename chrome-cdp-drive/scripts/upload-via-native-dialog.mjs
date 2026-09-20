// 【最后手段 · macOS · 不稳,见下】真实点击打开**系统文件对话框**,再用 AppleScript 把路径送进去。
//
// ⚠️ 先读这段,再决定要不要用:
//   这条路**没有被稳定复现**。实测(同一台机器、同一个页面、同一段脚本):
//   真实项目里成功过一次(文件确实进去了,靠页面里的 video duration 校验);事后用测试页复现,
//   连续几次都是"对话框开着、文件没进去"。
//   所以:**只在 1) 和 2) 两条路都试过、都不行时才用它**,而且跑完必须回头验证页面真的收到了文件
//   (input.files.length / video duration / 出现已上传提示),**没有验证 = 没有成功**。
//   它失败时不会乱点别的东西,但也不会帮你把文件弄进去 —— 失败就停下来让用户自己在对话框里选,
//   别反复重试(每次重试都要抢一次前台焦点)。
//
// 该先试的两条路(代价从小到大):
//   1) DOM.setFileInputFiles(直接塞 input)—— 大多数站点够用,见 douyin-publish/scripts/set-file-input.mjs;
//   2) Page.setInterceptFileChooserDialog + 真实点击 + DOM.setFileInputFiles(backendNodeId)
//      —— 见 kuaishou-publish/scripts/upload-via-file-chooser.mjs。
//      实测快手**视频**上传页连 2) 都不认:返回成功、files.length 立刻回 0、Network 域里
//      一条上传请求都没有(别把"没报错"当成"上传中")。这时才轮到本脚本。
//
// 用法:
//   node upload-via-native-dialog.mjs --ws <webSocketDebuggerUrl> --file /abs/path/a.mp4
//        [--find '<JS 返回要点的元素>']   # 省略 = 对话框已经开着,直接往里送路径
//        [--proc "Google Chrome"]         # 默认按 /json/version 自动判断 Chrome / Edge
//        [--verify '<JS,返回 true 表示页面确实收到了文件>']   # 强烈建议给
// 输出 JSON,退出码 0 表示"对话框关了",**不表示文件进去了** —— 以 --verify 的结果为准。
//
// 实测踩到的四个坑(改脚本前先看):
//   * AppleScript 必须**指定进程**:`tell process "Google Chrome"`。只写
//     `tell application "System Events" to keystroke ...` 不报错、键却掉不到对话框上。
//   * **别碰 `text field 1`**。打开面板里那个 text field 是**「搜索文本栏」**(desc=搜索文本栏),
//     `set value` 只是搜一下,不会选中文件;更糟的是焦点留在搜索框里会把后面的
//     `Cmd+Shift+G` 吃掉,表现为"脚本全跑完、对话框还开着"。要送路径只能靠"前往文件夹"。
//   * 判断键盘通道是否通,最快的探针是 **Esc**(`key code 53`):能关掉对话框说明按键能落到面板上。
//   * sheet 可能挂在**不是 window 1** 的窗口上(多窗口时),遍历所有窗口找 sheet。

import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const opt = { waitOpen: "9000", attempts: "2" };
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) opt[argv[i].slice(2)] = argv[++i];
}
const wsUrl = opt.ws || process.env.CDP_WS;
const file = opt.file || process.env.CDP_FILE;
const findExpr = opt.find || process.env.CDP_FIND || "";
const verifyExpr = opt.verify || process.env.CDP_VERIFY || "";
let proc = opt.proc || null;
if (!wsUrl || !file) {
  console.error("需要 --ws(或 CDP_WS) 和 --file(或 CDP_FILE)");
  process.exit(1);
}
if (!file.startsWith("/")) {
  console.error("--file 必须是绝对路径");
  process.exit(1);
}
const waitOpen = Number(opt.waitOpen) || 9000;
const maxAttempts = Number(opt.attempts) || 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const osa = (script) => {
  try {
    return execFileSync("osascript", ["-e", script], { encoding: "utf8" }).trim();
  } catch (e) {
    return "ERR:" + String(e.stderr || e.message).trim().slice(0, 120);
  }
};

const sheetOpen = () =>
  osa(
    `tell application "System Events" to tell process "${proc}" to return (count of sheets of every window)`
  ) !== "0";

const probeBrowser = async () => {
  const port = (wsUrl.match(/:(\d+)\//) || [])[1] || "9222";
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`);
    const j = await r.json();
    return /Edg\//.test(j.Browser || "") ? "Microsoft Edge" : "Google Chrome";
  } catch {
    return "Google Chrome";
  }
};

// 唯一用过一次的送路径方式:Cmd+Shift+G("前往文件夹") → 绝对路径 → 回车(定位)→ 回车(打开)
const submitByKeystroke = (path) => {
  const esc = path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return osa(`
    tell application "${proc}" to activate
    delay 1.2
    tell application "System Events"
      tell process "${proc}"
        set frontmost to true
        delay 0.6
        keystroke "g" using {command down, shift down}
        delay 1.5
        keystroke "${esc}"
        delay 1.0
        key code 36
        delay 1.5
        key code 36
      end tell
    end tell
    return "typed"
  `);
};

const ws = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  }
};
ws.onerror = (e) => {
  console.error("WS error:", e.message || e);
  process.exit(1);
};

const evalIn = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("EVAL: " + JSON.stringify(r.exceptionDetails.exception));
  return r.result.value;
};

ws.onopen = async () => {
  const out = { file, proc: null, clicked: null, sheetOpened: false, sheetClosed: false, verified: null };
  try {
    if (!proc) proc = await probeBrowser();
    out.proc = proc;

    if (findExpr) {
      await send("Page.enable");
      await send("Runtime.enable");
      await sleep(200);
      if (sheetOpen()) out.preexistingSheet = true; // 有陈旧对话框先别动手,免得敲到它上面
      const r = await send("Runtime.evaluate", { expression: findExpr, returnByValue: false });
      const objectId = r.result && r.result.objectId;
      if (!objectId) throw new Error("--find 未命中");
      const box = await send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration:
          "function(){ this.scrollIntoView({block:'center',inline:'center'});" +
          "const r=this.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),w:Math.round(r.width),h:Math.round(r.height),t:(this.textContent||'').trim().slice(0,20)}; }",
        returnByValue: true,
      });
      const b = box.result.value;
      out.clicked = b;
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: b.x, y: b.y });
      await sleep(250);
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: b.x, y: b.y, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", clickCount: 1 });
    } else {
      await send("Runtime.enable");
    }

    for (let waited = 0; waited < waitOpen; waited += 300) {
      await sleep(300);
      if (sheetOpen()) {
        out.sheetOpened = true;
        break;
      }
    }
    if (!out.sheetOpened) {
      console.log(JSON.stringify(out, null, 2));
      console.error("没等到系统文件对话框 —— 点击没落在触发元素上(或该站点不用系统对话框)");
      ws.close();
      process.exit(2);
    }

    await sleep(1500); // 面板"存在得很快、可用得慢",刚出现就操作会静默无效
    for (let attempt = 1; attempt <= maxAttempts && !out.sheetClosed; attempt++) {
      out.tries = attempt;
      out["try" + attempt] = submitByKeystroke(file);
      for (let waited = 0; waited < 6000; waited += 400) {
        await sleep(400);
        if (!sheetOpen()) {
          out.sheetClosed = true;
          break;
        }
      }
    }

    if (verifyExpr) {
      try {
        out.verified = await evalIn(`(()=>{ try { return (${verifyExpr}); } catch(e){ return "verify-error:"+e.message } })()`);
      } catch (e) {
        out.verified = "verify-error:" + e.message;
      }
    }

    console.log(JSON.stringify(out, null, 2));
    if (!out.sheetClosed || out.verified === false) {
      console.error(
        "没成功。别重试了 —— 让用户自己在弹出的对话框里选文件(或者改用拖拽)." +
          " 排查顺序:进程名对不对(--proc) → 是不是先碰过搜索栏 → Esc 能不能关掉对话框(验键盘通道)"
      );
      ws.close();
      process.exit(3);
    }
  } catch (e) {
    console.error("ERROR:", e.message);
    process.exit(4);
  } finally {
    ws.close();
    process.exit(0);
  }
};

setTimeout(() => {
  console.error("TIMEOUT");
  process.exit(5);
}, 90000);
