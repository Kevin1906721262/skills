// 在页面里输入文本(聚焦元素 → Input.insertText 真实输入,可选回车)。
// 用法:
//   CDP_WS=ws://... CDP_FIND='<JS 返回要聚焦的元素>' CDP_TEXT='要输入的文字' [CDP_ENTER=1] node cdp-type.mjs
//   或不给 CDP_FIND 直接对当前焦点输入。
// 输出 JSON: { focused:{tag,cls,textBefore}, typed, textAfter, enter }
const wsUrl = process.env.CDP_WS;
const findExpr = process.env.CDP_FIND || null;
const text = process.env.CDP_TEXT || "";
const wantEnter = process.env.CDP_ENTER === "1";
if (!wsUrl) {
  console.error("需要 CDP_WS");
  process.exit(1);
}

const ws = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
  }
};

ws.onerror = (e) => {
  console.error("WS error:", e.message || e);
  process.exit(1);
};

const readFocused = `
  (() => {
    const e = document.activeElement;
    if (!e) return null;
    return {
      tag: e.tagName,
      cls: (typeof e.className === 'string' ? e.className : '').slice(0, 80),
      editable: e.isContentEditable,
      text: (e.innerText !== undefined && e.isContentEditable ? e.innerText : (e.value || '')).slice(0, 200),
    };
  })()`;

ws.onopen = async () => {
  const out = {};
  try {
    await send("Runtime.enable");
    await new Promise((r) => setTimeout(r, 300));

    if (findExpr) {
      const r1 = await send("Runtime.evaluate", { expression: findExpr, returnByValue: false });
      const objId = r1.result && r1.result.objectId;
      if (!objId) {
        console.log(JSON.stringify({ error: "聚焦元素未找到" }));
        process.exit(0);
      }
      const r2 = await send("Runtime.callFunctionOn", {
        objectId: objId,
        functionDeclaration: `function(){ this.scrollIntoView({block:'center',inline:'center'}); this.focus();
          const r=this.getBoundingClientRect();
          return { tag:this.tagName, cls:(typeof this.className==='string'?this.className:'').slice(0,80),
                   editable:this.isContentEditable, x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2) }; }`,
        returnByValue: true,
      });
      out.focused = r2.result.value;
      // 有些 contenteditable 需要一次真实点击才会激活
      if (out.focused) {
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: out.focused.x, y: out.focused.y });
        await send("Input.dispatchMouseEvent", { type: "mousePressed", x: out.focused.x, y: out.focused.y, button: "left", clickCount: 1 });
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: out.focused.x, y: out.focused.y, button: "left", clickCount: 1 });
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    const before = await send("Runtime.evaluate", { expression: readFocused, returnByValue: true });
    out.before = before.result.value;

    if (text) {
      await send("Input.insertText", { text });
      await new Promise((r) => setTimeout(r, 500));
    }
    out.typed = text;

    const after = await send("Runtime.evaluate", { expression: readFocused, returnByValue: true });
    out.after = after.result.value;

    if (wantEnter) {
      for (const t of ["keyDown", "char", "keyUp"]) {
        await send("Input.dispatchKeyEvent", {
          type: t, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
          text: t === "char" ? "\r" : undefined,
        });
      }
      out.enter = true;
      await new Promise((r) => setTimeout(r, 800));
    }

    console.log(JSON.stringify(out, null, 2));
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
}, 25000);
