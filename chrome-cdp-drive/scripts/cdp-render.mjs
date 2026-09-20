#!/usr/bin/env node
/**
 * cdp-render.mjs — 渲染一个 HTML 文件/网址并截成 PNG(临时标签页,截完即关)。
 *
 * 用途:把本地 HTML 渲染成图时,借用户已经在跑的那个浏览器开临时标签页,
 * 而不是起 --headless。理由(跨平台成立,见 SKILL.md §3.5):
 *   1) headless 用全新临时 profile,拿不到登录态;这里借的是日常 profile
 *   2) Emulation.setDeviceMetricsOverride 让像素 = CSS 尺寸 × 缩放,可控可复现
 *   3) 用完即关,不污染用户正在看的窗口
 *   PUT /json/new → Emulation.setDeviceMetricsOverride → Page.captureScreenshot → PUT /json/close
 *
 * 用法:
 *   node cdp-render.mjs <fileOrUrl> <outPng> [width=1400] [height=720] [scale=2]
 *   CDP_PORT=9223 node cdp-render.mjs ...        # 换成隔离实例
 */
import { writeFileSync } from "node:fs";

const [target, outPng, w = "1400", h = "720", scale = "2"] = process.argv.slice(2);
if (!target || !outPng) {
  console.error("用法: node cdp-render.mjs <fileOrUrl> <outPng> [width] [height] [scale]");
  process.exit(1);
}
const PORT = process.env.CDP_PORT || 9222;
const width = Number(w);
const height = Number(h);
const dsf = Number(scale); // 2 = 高分屏清晰度(最终像素 = CSS 尺寸 × dsf)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = (path, init) => fetch(`http://127.0.0.1:${PORT}${path}`, init);

let tab;
try {
  tab = await (await api(`/json/new?${encodeURIComponent(target)}`, { method: "PUT" })).json();
} catch {
  console.error(`连不上 Chrome 调试口 127.0.0.1:${PORT}(先按 SKILL.md §1 检查/启动自动化 Chrome)`);
  process.exit(1);
}
if (!tab.webSocketDebuggerUrl) {
  console.error(`开标签页失败: ${JSON.stringify(tab)}`);
  process.exit(1);
}

const ws = new WebSocket(tab.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const msgId = ++id;
    pending.set(msgId, { res, rej });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
  }
};

await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error("WebSocket 连接失败"));
});

try {
  await send("Page.enable");
  // 固定视口尺寸,不依赖窗口当前大小;deviceScaleFactor 直接决定输出分辨率
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dsf, mobile: false });
  await sleep(Number(process.env.CDP_WAIT || 1500)); // 等字体/图片/首屏渲染
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(outPng, Buffer.from(shot.data, "base64"));
  console.log(JSON.stringify({ ok: true, outPng, target, width, height, dsf, px: [width * dsf, height * dsf] }));
} catch (e) {
  console.error(`渲染失败: ${e.message}`);
  process.exitCode = 1;
} finally {
  await api(`/json/close/${tab.id}`, { method: "PUT" }).catch(() => {});
  process.exit(process.exitCode || 0);
}
