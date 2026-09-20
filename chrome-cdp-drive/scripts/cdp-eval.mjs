// CDP 求值:在指定 page 执行 JS 表达式,打印 JSON 结果。
// 用法: CDP_WS=ws://... CDP_EXPR='...' node cdp-eval.mjs
//   CDP_EXPR 支持 async 表达式(awaitPromise)。异常时打印 EXCEPTION 并以退出码 2 结束。
const wsUrl = process.env.CDP_WS;
const expr = process.env.CDP_EXPR;
if (!wsUrl || !expr) {
  console.error("需要 CDP_WS 和 CDP_EXPR");
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
    // 等页面加载完成(限时 15s)
    const deadline = Date.now() + 15000;
    for (;;) {
      const r = await send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
      if (r.result && r.result.value === "complete") break;
      if (Date.now() > deadline) break;
      await new Promise((res) => setTimeout(res, 500));
    }
    const res = await send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.exceptionDetails) {
      console.error("EXCEPTION:", JSON.stringify(res.exceptionDetails, null, 2));
      process.exit(2);
    }
    console.log(JSON.stringify(res.result.value, null, 2));
  } catch (e) {
    console.error("ERROR:", e.message);
    process.exit(3);
  } finally {
    ws.close();
    process.exit(0);
  }
};

setTimeout(() => {
  console.error("TIMEOUT waiting for ws open");
  process.exit(4);
}, 20000);
