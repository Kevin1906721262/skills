// 在「无界(wujie)微前端」页面里定位元素 / 真实点击 / 真实输入。
//
// 为什么需要单独一个脚本: channels.weixin.qq.com(视频号助手) 的真实 DOM 挂在
//   document.querySelector("wujie-app").shadowRoot
// 里,document.querySelector 一个都匹配不到 —— cdp-eval / cdp-click / cdp-keys 的
// CDP_SEL_* 参数全部失效。这个脚本把表达式包一层,把 `APP` 预置成那个 shadow root。
//
// 用法(env 或 --参数 都行):
//   node shadow-el.mjs --ws <ws> --find '<JS,可用 APP>' [--click] [--text 文字] [--type 文字]
//        [--keys Backspace] [--end] [--all] [--after '<JS,可用 APP>'] [--shot /tmp/x.png]
//
//   --find   必填,求值得到目标元素(在 APP 里找),如 'APP.querySelector("div.input-editor")'
//   --click  真实鼠标(移到→按下→抬起)点它的中心;不做 scrollIntoView 的话用 --noscroll
//   --end / --all   把选区先收拢到元素内容末尾 / 全选(写入前摆光标,富文本必用)
//   --text   Input.insertText 一次性插入(纯文本最稳)
//   --type   逐字符真实按键(打 # / @ 触发联想面板时必用)
//   --keys   逗号分隔的真实按键,如 'Backspace' / 'meta+a,Backspace'
//   --shot   结束时截图
// 输出 JSON: 命中元素的信息 + 动作后的回读(editable/value/text),写没写进去一目了然。

const argv = process.argv.slice(2);
const o = {};
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith("--")) continue;
  const k = argv[i].slice(2);
  o[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "1";
}
const wsUrl = o.ws || process.env.CDP_WS;
const find = o.find || process.env.CDP_FIND;
if (!wsUrl || !find) {
  console.error("需要 --ws(或 CDP_WS) 和 --find(或 CDP_FIND)");
  process.exit(1);
}

// 预置 APP 的作用域包装:拿不到 wujie-app 就退回 document
const wrap = (expr) =>
  `(()=>{const H=document.querySelector("wujie-app");const APP=(H&&H.shadowRoot)||document;return (${expr});})()`;

const keys = (o.keys || "").split(",").map((s) => s.trim()).filter(Boolean);
const KEYMAP = {
  Backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  Delete: { key: "Delete", code: "Delete", vk: 46 },
  Enter: { key: "Enter", code: "Enter", vk: 13 },
  Escape: { key: "Escape", code: "Escape", vk: 27 },
  Tab: { key: "Tab", code: "Tab", vk: 9 },
  End: { key: "End", code: "End", vk: 35 },
  a: { key: "a", code: "KeyA", vk: 65 },
};

const ws = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
  }
};
ws.onerror = (e) => {
  console.error("WS error", e.message || e);
  process.exit(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evalIn = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("EVAL: " + JSON.stringify(r.exceptionDetails.exception).slice(0, 300));
  return r.result.value;
};

const READ = `function(){const r=this.getBoundingClientRect();return {
  tag:this.tagName, cls:(typeof this.className==="string"?this.className:"").slice(0,70),
  editable:this.isContentEditable, value:this.isContentEditable?null:this.value,
  text:(this.innerText||"").slice(0,300), html:(this.innerHTML||"").slice(0,300),
  disabled:!!this.disabled, rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]};}`;

ws.onopen = async () => {
  const out = {};
  try {
    await send("Runtime.enable");
    await send("Page.enable");
    await sleep(300);

    const r1 = await send("Runtime.evaluate", { expression: wrap(find), returnByValue: false });
    const objId = r1.result && r1.result.objectId;
    if (!objId) {
      const diag = await evalIn(
        wrap(`({hasHost:!!document.querySelector("wujie-app"), hasShadow:!!(document.querySelector("wujie-app")||{}).shadowRoot})`)
      );
      console.log(JSON.stringify({ error: "元素未找到", diag }, null, 1));
      process.exit(0);
    }
    const call = (fn) =>
      send("Runtime.callFunctionOn", { objectId: objId, functionDeclaration: fn, returnByValue: true });

    out.before = (await call(READ)).result.value;

    if (o.click) {
      const pos = (await call(`function(){ this.scrollIntoView({block:'center',inline:'center'});
        const r=this.getBoundingClientRect();
        return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),w:Math.round(r.width),h:Math.round(r.height)}; }`))
        .result.value;
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pos.x, y: pos.y });
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
      out.clicked = pos;
      await sleep(400);
    }

    // 只要要写入,就先把焦点和选区摆好 —— Input.insertText 打给的是「当前焦点」,
    // 不 focus 的话纯文本 input 会静默不写(实测:value 保持空),光看命令没报错会误判成功。
    if (o.end || o.all || o.text || o.type || keys.length) {
      await call(`function(){ if(document.activeElement!==this) this.focus();
        const w=this.ownerDocument.defaultView; const rng=this.ownerDocument.createRange(); rng.selectNodeContents(this);
        ${o.all ? "" : "rng.collapse(false);"}
        const s=w.getSelection(); s.removeAllRanges(); s.addRange(rng); return 1; }`);
      await sleep(150);
    }

    for (const k of keys) {
      const parts = k.split("+");
      const name = parts[parts.length - 1];
      const mods = parts.slice(0, -1).map((p) => p.toLowerCase());
      let bits = 0;
      if (mods.includes("meta") || mods.includes("cmd")) bits |= 4;
      if (mods.includes("shift")) bits |= 8;
      if (mods.includes("ctrl")) bits |= 2;
      if (mods.includes("alt")) bits |= 1;
      const kk = KEYMAP[name] || { key: name, code: name, vk: 0 };
      await send("Input.dispatchKeyEvent", { type: "rawKeyDown", modifiers: bits, key: kk.key, code: kk.code, windowsVirtualKeyCode: kk.vk, nativeVirtualKeyCode: kk.vk });
      await send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: bits, key: kk.key, code: kk.code, windowsVirtualKeyCode: kk.vk, nativeVirtualKeyCode: kk.vk });
      await sleep(150);
    }

    if (o.text) {
      await send("Input.insertText", { text: o.text });
      await sleep(600);
    }
    if (o.type) {
      for (const ch of o.type) {
        if (ch === "\n") {
          await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r" });
          await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        } else {
          await send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch });
          await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
        }
        await sleep(40);
      }
      await sleep(400);
    }

    if (o.after) out.after = await evalIn(wrap(o.after));
    out.el = (await call(READ)).result.value;

    if (o.shot) {
      await sleep(400);
      const shot = await send("Page.captureScreenshot", { format: "png" });
      const fs = await import("node:fs");
      fs.writeFileSync(o.shot, Buffer.from(shot.data, "base64"));
      out.screenshot = o.shot;
    }
    console.log(JSON.stringify(out, null, 1));
  } catch (e) {
    console.error("ERROR:", e.message);
    process.exit(2);
  } finally {
    ws.close();
    process.exit(0);
  }
};
setTimeout(() => {
  console.error("TIMEOUT");
  process.exit(4);
}, 40000);
