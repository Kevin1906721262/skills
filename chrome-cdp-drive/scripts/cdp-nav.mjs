// 导航当前页签到指定 URL,等待加载完成,打印 {url, title}。
// 用法: CDP_WS=ws://... CDP_URL='https://...' node cdp-nav.mjs
const wsUrl = process.env.CDP_WS;
const url = process.env.CDP_URL;
if (!wsUrl || !url) {
  console.error("需要 CDP_WS 和 CDP_URL");
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

ws.onopen = async () => {
  try {
    await send("Runtime.enable");
    await send("Page.enable");
    await send("Page.navigate", { url });
    // 等 readyState complete(限时 20s);若跳转出错(如风控页)也能拿到最终 url
    const deadline = Date.now() + 20000;
    for (;;) {
      await new Promise((r) => setTimeout(r, 600));
      const st = await send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
      if (st.result && st.result.value === "complete") break;
      if (Date.now() > deadline) break;
    }
    const info = await send("Runtime.evaluate", {
      expression: "({ url: location.href, title: document.title })",
      returnByValue: true,
    });
    console.log(JSON.stringify(info.result.value, null, 2));
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
