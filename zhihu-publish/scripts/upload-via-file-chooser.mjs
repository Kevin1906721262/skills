// 真实点击某个元素触发原生文件选择框，再用 CDP 把本地文件交给它。
//
// 为什么需要它: 知乎创作中心的图片上传必须先点「本地图片上传」这个方块，才会弹系统文件
// 选择框；直接对页面里那个隐藏的 input[type=file] 调 DOM.setFileInputFiles，files.length
// 会变成 1、页面却毫无反应。走「真实点击 → 拦截 fileChooserOpened → 用 backendNodeId 设文件」
// 才生效。
//
// 用法:
//   node upload-via-file-chooser.mjs --ws <webSocketDebuggerUrl> --file /abs/path.jpg
//        [--find '<JS 表达式, 返回要点击的元素>'] [--wait 6000]
//   CDP_WS / CDP_FILE / CDP_FIND 可代替对应参数。
//
// --find 默认找文本为「本地图片上传」的最小可点元素(知乎上传弹窗里的方块)。
// 输出 JSON: 点击坐标、拿到的 backendNodeId、操作后的页面片段。

const argv = process.argv.slice(2);
const opt = { wait: "6000" };
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) opt[argv[i].slice(2)] = argv[++i];
}
const wsUrl = opt.ws || process.env.CDP_WS;
const file = opt.file || process.env.CDP_FILE;
const findExpr =
  opt.find ||
  process.env.CDP_FIND ||
  `(()=>{const c=[...document.querySelectorAll('div,button,span')].filter(x=>{
      const r=x.getBoundingClientRect(); return r.width>40&&r.height>20&&(x.textContent||'').trim()==="本地图片上传";});
    return c.sort((a,b)=>{const ra=a.getBoundingClientRect(),rb=b.getBoundingClientRect();
      return ra.width*ra.height-rb.width*rb.height;})[0]||null;})()`;

if (!wsUrl || !file) {
  console.error("需要 --ws(或 CDP_WS) 和 --file(或 CDP_FILE)");
  process.exit(1);
}
if (!file.startsWith("/")) {
  console.error("--file 必须是绝对路径");
  process.exit(1);
}

const ws = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();
const events = [];
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
  } else if (m.method) {
    events.push(m);
  }
};
ws.onerror = (e) => {
  console.error("WS error:", e.message || e);
  process.exit(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ws.onopen = async () => {
  try {
    await send("Page.enable");
    await send("DOM.enable");
    await send("Runtime.enable");
    await send("Page.setInterceptFileChooserDialog", { enabled: true });

    // 1) 找到目标元素并取中心坐标
    const r = await send("Runtime.evaluate", { expression: findExpr, returnByValue: false });
    if (r.exceptionDetails) throw new Error("FIND EXCEPTION: " + JSON.stringify(r.exceptionDetails.exception));
    const objectId = r.result.objectId;
    if (!objectId) throw new Error("元素未找到(注意知乎有隐藏的同名元素, --find 里要过滤 getBoundingClientRect)");

    const box = await send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration:
        "function(){this.scrollIntoView({block:'center'});const r=this.getBoundingClientRect();" +
        "return {x:r.x+r.width/2,y:r.y+r.height/2,w:Math.round(r.width),h:Math.round(r.height),t:(this.textContent||'').trim().slice(0,20)};}",
      returnByValue: true,
    });
    const { x, y, w, h, t } = box.result.value;
    if (x < 0 || x > 1400) console.error(`警告: 点击坐标 x=${Math.round(x)} 可能在视口外`);

    // 2) 真实鼠标点击(带用户手势)
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });

    // 3) 等 fileChooserOpened 事件
    let backendNodeId = null;
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && !backendNodeId) {
      const ev = events.find((e) => e.method === "Page.fileChooserOpened");
      if (ev) backendNodeId = ev.params.backendNodeId || null;
      if (!backendNodeId) await sleep(200);
    }
    if (!backendNodeId) throw new Error("没等到文件选择框事件(点击可能没触发展开)");

    // 4) 把文件塞进这个 input
    await send("DOM.setFileInputFiles", { backendNodeId, files: [file] });
    await sleep(Number(opt.wait));

    const after = await send("Runtime.evaluate", {
      expression: `(()=>{const b=document.body.innerText.replace(/\\n+/g," | ");
        return {head:b.slice(0,240),
                fileInputs:[...document.querySelectorAll("input[type=file]")].map(e=>e.files.length),
                bigImgs:[...document.querySelectorAll("img")].filter(e=>e.getBoundingClientRect().width>60).length,
                insertBtn:[...document.querySelectorAll("button")].some(x=>(x.textContent||"").trim()==="插入图片")};})()`,
      returnByValue: true,
    });

    console.log(JSON.stringify({ ok: true, file, clicked: { x, y, w, h, t }, backendNodeId, after: after.result.value }, null, 2));
    clearTimeout(guard);
    ws.close();
  } catch (e) {
    console.error("ERROR:", e.message);
    process.exit(1);
  }
};

const guard = setTimeout(() => {
  console.error("TIMEOUT waiting for ws open");
  process.exit(4);
}, 30000);
