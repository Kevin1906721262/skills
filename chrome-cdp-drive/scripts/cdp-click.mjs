// 点击页面元素:用 CDP Input 域发"真实"鼠标事件(trusted),比 el.click() 更接近真人。
// 用法:
//   CDP_WS=ws://... CDP_FIND='<JS 表达式,返回要点击的 DOM 元素或 null>' node cdp-click.mjs
//   可选: CDP_AFTER='<JS 表达式,点击后求值打印>'  CDP_SHOT=<out.png>
// CDP_FIND 示例(文本+class+可见三连):
//   (() => { const v=(e)=>{const r=e.getBoundingClientRect();return r.width>10&&r.height>10;};
//            const e=[...document.querySelectorAll('div,button,[role="button"],a')]
//              .find(x=>{const t=(x.textContent||'').trim();return v(x)&&t.includes('已訂閱');});
//            return e||null; })()
const wsUrl = process.env.CDP_WS;
const findExpr = process.env.CDP_FIND;
if (!wsUrl || !findExpr) {
  console.error("需要 CDP_WS 和 CDP_FIND");
  process.exit(1);
}
const afterExpr = process.env.CDP_AFTER || null;
const shotPath = process.env.CDP_SHOT || null;

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

ws.onopen = async () => {
  try {
    await send("Runtime.enable");
    await send("Page.enable");
    await new Promise((r) => setTimeout(r, 400));

    // 1) 求值 CDP_FIND,拿到元素的对象引用
    const r1 = await send("Runtime.evaluate", { expression: findExpr, returnByValue: false });
    const objId = r1.result && r1.result.objectId;
    if (!objId) {
      console.log(JSON.stringify({ error: "元素未找到", findResult: r1.result && r1.result.value }));
      process.exit(0);
    }

    // 2) 让元素滚动到可视,返回中心坐标
    const r2 = await send("Runtime.callFunctionOn", {
      objectId: objId,
      functionDeclaration: `function() {
        this.scrollIntoView({ block: 'center', inline: 'center' });
        const r = this.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
                 w: Math.round(r.width), h: Math.round(r.height),
                 text: (this.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60) };
      }`,
      returnByValue: true,
    });
    const pos = r2.result.value;
    if (!pos) {
      console.log(JSON.stringify({ error: "无法获取元素坐标" }));
      process.exit(0);
    }

    // 3) 真实鼠标:移到→按下→抬起
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pos.x, y: pos.y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1 });

    const out = { clicked: { x: pos.x, y: pos.y, w: pos.w, h: pos.h, text: pos.text } };

    // 4) 可选:点击后等待再求值(读状态/弹窗)
    if (afterExpr) {
      await new Promise((r) => setTimeout(r, 1500));
      const ra = await send("Runtime.evaluate", { expression: afterExpr, returnByValue: true, awaitPromise: true });
      out.after = ra.exceptionDetails ? { exception: JSON.stringify(ra.exceptionDetails).slice(0, 300) } : ra.result.value;
    }

    // 5) 可选:截图
    if (shotPath) {
      await new Promise((r) => setTimeout(r, 500));
      const shot = await send("Page.captureScreenshot", { format: "png" });
      const fs = await import("node:fs");
      fs.writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
      out.screenshot = shotPath;
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
