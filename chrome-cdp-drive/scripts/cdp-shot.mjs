// 截图(支持整页)。
// 用法: CDP_WS=ws://... [CDP_NAV=url] [CDP_OUT=<out.png>] [CDP_FULL=true] node cdp-shot.mjs
//   CDP_FULL=true → 整页截图(captureBeyondViewport);否则只截当前视口。
//   CDP_OUT 缺省落在系统临时目录(Windows 下 %TEMP%)。
import { tmpdir } from "node:os";
import { join } from "node:path";

const wsUrl = process.env.CDP_WS;
if (!wsUrl) {
  console.error("需要 CDP_WS");
  process.exit(1);
}
const nav = process.env.CDP_NAV || null;
const out = process.env.CDP_OUT || join(tmpdir(), "shot.png");
const full = process.env.CDP_FULL === "true";

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
    await send("Page.enable");
    if (nav) {
      await send("Page.navigate", { url: nav });
      await new Promise((r) => setTimeout(r, 4000));
    }
    const params = full ? { format: "png", captureBeyondViewport: true } : { format: "png" };
    const shot = await send("Page.captureScreenshot", params);
    const fs = await import("node:fs");
    fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
    console.log("saved", out);
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
}, 20000);
