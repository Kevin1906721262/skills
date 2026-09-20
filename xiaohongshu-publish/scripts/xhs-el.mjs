// 在小红书创作平台(或任意页面)按文本查找/点击元素 —— 可穿透 closed shadow root。
// 普通选择器与 elementFromPoint 都看不进 closed shadow root,而发布页底部的
// 「发布 / 暂存离开」就在自定义元素 xhs-publish-btn 的 closed shadow root 里,
// 所以必须走 CDP DOM 域:getDocument(pierce) → getBoxModel → Input.dispatchMouseEvent。
//
// 用法:
//   node xhs-el.mjs --ws <webSocketDebuggerUrl> --text 发布 [--tag BUTTON] [--contains] [--click] [--shot /tmp/a.png] [--wait 1500]
//   CDP_WS 环境变量可代替 --ws; CDP_TEXT 可代替 --text。
//
// 不带 --click: 只打印所有命中元素(tag/class/坐标/尺寸),便于先看清再动手。
// 带   --click: 命中多个时优先选 <button>,否则选面积最小的那个发真实鼠标事件。

const argv = process.argv.slice(2);
const opt = { wait: 1500 };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--contains") opt.contains = true;
  else if (a === "--click") opt.click = true;
  else if (a.startsWith("--")) opt[a.slice(2)] = argv[++i];
}
const wsUrl = opt.ws || process.env.CDP_WS;
const text = opt.text || process.env.CDP_TEXT;
if (!wsUrl || !text) {
  console.error("需要 --ws(或 CDP_WS) 和 --text(或 CDP_TEXT)");
  process.exit(1);
}

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
    await send("DOM.enable");
    await send("Page.enable");
    const doc = await send("DOM.getDocument", { depth: -1, pierce: true });

    const hits = [];
    const walk = (n) => {
      if (!n) return;
      if (n.nodeName === "#text") {
        const t = (n.nodeValue || "").trim();
        if (t && (opt.contains ? t.includes(text) : t === text)) hits.push({ t, parentId: n.parentId });
      }
      (n.children || []).forEach(walk);
      (n.shadowRoots || []).forEach(walk);
      if (n.contentDocument) walk(n.contentDocument);
    };
    walk(doc.root);

    const matches = [];
    for (const h of hits) {
      let node = { nodeName: "?", attributes: [] };
      try {
        node = (await send("DOM.describeNode", { nodeId: h.parentId })).node;
      } catch (e) {}
      const attrs = {};
      for (let i = 0; i < (node.attributes || []).length; i += 2) attrs[node.attributes[i]] = node.attributes[i + 1];
      let box = null;
      try {
        const q = (await send("DOM.getBoxModel", { nodeId: h.parentId })).model.border;
        const w = Math.round(q[2] - q[0]);
        const hh = Math.round(q[5] - q[1]);
        if (w > 0 && hh > 0) box = { x: Math.round((q[0] + q[4]) / 2), y: Math.round((q[1] + q[5]) / 2), w, h: hh };
      } catch (e) {}
      matches.push({
        text: h.t,
        tag: node.nodeName,
        cls: attrs.class || "",
        nodeId: h.parentId,
        box,
        area: box ? box.w * box.h : Infinity,
      });
    }

    const out = { found: matches.map(({ nodeId, area, ...rest }) => rest) };
    if (opt.click) {
      const visible = matches.filter((m) => m.box);
      if (!visible.length) {
        out.error = "没有可见的命中元素";
      } else {
        // 命中多个时:优先 --tag 指定的标签,其次 <button>,最后取面积最小(叶子元素)
        const byTag = opt.tag ? visible.filter((m) => m.tag === String(opt.tag).toUpperCase()) : [];
        const byArea = (a, b) => a.area - b.area;
        const target =
          byTag.sort(byArea)[0] ||
          visible.filter((m) => m.tag === "BUTTON").sort(byArea)[0] ||
          [...visible].sort(byArea)[0];
        const { x, y, w, h } = target.box;
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
        out.clicked = { tag: target.tag, cls: target.cls, x, y, w, h };
        await new Promise((r) => setTimeout(r, Number(opt.wait) || 1500));
      }
    }
    if (opt.shot) {
      const shot = await send("Page.captureScreenshot", { format: "png" });
      const fs = await import("node:fs");
      fs.writeFileSync(opt.shot, Buffer.from(shot.data, "base64"));
      out.screenshot = opt.shot;
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
