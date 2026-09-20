#!/usr/bin/env node
/**
 * 把素材里"需要登录态才能下"的图片落盘(飞书文档 / 内网图床 / 网盘预览图等)。
 *
 * 做法:借本机已登录 Chrome 的 cookie,直接用 node fetch 下载,避开大 base64 过 shell。
 * 注意 Network 域只在 page target 上有 —— 浏览器级 target 调 Network.getCookies 会报 -32601。
 *
 * 用法: node fetchimg.mjs <图片URL> <输出文件> [--port=9222] [--referer=<页面URL>]
 *   输出 JSON: { status, type, bytes, outFile }
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const flags = {};
const rest = [];
for (const a of argv) {
  const m = /^--([^=]+)(?:=([\s\S]*))?$/.exec(a);
  if (m) flags[m[1]] = m[2] === undefined ? true : m[2];
  else rest.push(a);
}
const [imgUrl, outArg] = rest;
if (!imgUrl || !outArg) {
  console.error("用法: node fetchimg.mjs <图片URL> <输出文件> [--port=9222] [--referer=<页面URL>]");
  process.exit(1);
}
const outFile = resolve(outArg);
const PORT = flags.port || 9222;

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const host = new URL(imgUrl).host.replace(/^[^.]+\./, ""); // 去掉最左一段子域后再匹配
const page =
  targets.find((t) => t.type === "page" && t.url.includes(host)) ||
  targets.find((t) => t.type === "page" && t.url.startsWith("http"));
if (!page) {
  console.error(`没找到可用于取 cookie 的页面(期望域名含 ${host})`);
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
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
await send("Network.enable");
const { cookies } = await send("Network.getCookies", { urls: [imgUrl] });
ws.close();

const resp = await fetch(imgUrl, {
  headers: {
    Cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
    Referer: flags.referer || page.url,
    Accept: "image/avif,image/webp,image/png,image/*,*/*;q=0.8",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
  },
});
if (!resp.ok) {
  console.error(`HTTP ${resp.status} ${resp.statusText}(cookie 取自 ${page.url})`);
  process.exit(2);
}
const buf = Buffer.from(await resp.arrayBuffer());
writeFileSync(outFile, buf);
console.log(
  JSON.stringify({ status: resp.status, type: resp.headers.get("content-type"), bytes: buf.length, outFile }, null, 1)
);
