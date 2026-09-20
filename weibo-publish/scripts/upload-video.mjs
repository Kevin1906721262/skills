// 给微博「视频发布」页(https://weibo.com/upload/channel)塞视频文件。
//
// 为什么不能直接 setFileInputFiles: 这个页面的 input[type=file] 直接塞会"假成功"
// —— 脚本 ok、filesAfter=0、页面纹丝不动地停在拖拽区，一条上传请求都没有。
// 必须真实点击「上传视频」按钮触发文件选择框，拦截 Page.fileChooserOpened 拿到
// backendNodeId，再用 DOM.setFileInputFiles 把文件交给它。
//
// 用法:
//   node upload-video.mjs --ws <webSocketDebuggerUrl> --file /abs/path/a.mp4
//        [--find '<JS 表达式, 返回要点击的元素>'] [--wait 8000]
//   CDP_WS / CDP_FILE / CDP_FIND 可代替对应参数。
//
// --find 默认取"文本精确等于 上传视频、在视口内、面积最小"的元素(页面上「上传视频」
// 出现两次: 大标题 + 按钮，大标题面积大得多)。
//
// 输出 JSON: 点击坐标、backendNodeId，以及上传后的判据 —— 页面文案(看到「上传完成」
// 才算进去了)、表单字段是否可见(标题输入框 offsetParent 非空)、封面帧数量。
//
// ⚠️ 别拿这个页面的 <video> 当判据: 它是个空壳模板(src 为空、duration null、
// videoWidth 0)，上传成功后也不会被填。上传成功的真判据是文案「上传完成」+ 表单可见 + 封面帧出现。

const argv = process.argv.slice(2);
const opt = { wait: "8000" };
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) opt[argv[i].slice(2)] = argv[++i];
}
const wsUrl = opt.ws || process.env.CDP_WS;
const file = opt.file || process.env.CDP_FILE;
const findExpr =
  opt.find ||
  process.env.CDP_FIND ||
  `(()=>{const c=[...document.querySelectorAll("div,button,span,a")].filter(x=>{
      const r=x.getBoundingClientRect();
      return r.width>40&&r.height>20&&r.top>=0&&r.left>=0&&
             (x.textContent||"").trim()==="上传视频";});
    return c.sort((a,b)=>{const ra=a.getBoundingClientRect(),rb=b.getBoundingClientRect();
      return ra.width*ra.height-rb.width*rb.height;})[0]||null;})()`;

if (!wsUrl || !file) {
  console.error("需要 --ws(或 CDP_WS) 和 --file(或 CDP_FILE)");
  process.exit(1);
}
if (!file.startsWith("/")) {
  console.error("--file 必须是绝对路径(浏览器进程与页面共享本机文件系统)");
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

// 上传后的判据: 文案 + 表单是否可见 + 封面帧数量
const VERIFY = `(()=>{
  const b=document.body.innerText.replace(/\\n+/g," | ");
  const t=document.querySelector('input[placeholder^="填写标题"]');
  return {
    head: b.slice(0,260),
    uploaded: b.includes("上传完成"),
    formVisible: !!(t&&t.offsetParent),
    coverFrames: document.querySelectorAll("div.woo-picture-main[class*=a5item]").length,
    fileInputs:[...document.querySelectorAll("input[type=file]")].map(e=>e.files.length)
  };})()`;

ws.onopen = async () => {
  try {
    await send("Page.enable");
    await send("DOM.enable");
    await send("Runtime.enable");
    await send("Page.setInterceptFileChooserDialog", { enabled: true });

    // 1) 找到目标元素并取中心坐标(点前先滚进视口，否则点的是屏幕外的坐标)
    const r = await send("Runtime.evaluate", { expression: findExpr, returnByValue: false });
    if (r.exceptionDetails) throw new Error("FIND EXCEPTION: " + JSON.stringify(r.exceptionDetails.exception));
    const objectId = r.result.objectId;
    if (!objectId) throw new Error("元素未找到(是不是没在 /upload/channel 页？)");

    const box = await send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration:
        "function(){this.scrollIntoView({block:'center'});const r=this.getBoundingClientRect();" +
        "return {x:r.x+r.width/2,y:r.y+r.height/2,w:Math.round(r.width),h:Math.round(r.height),t:(this.textContent||'').trim().slice(0,20)};}",
      returnByValue: true,
    });
    const { x, y, w, h, t } = box.result.value;
    if (x < 0 || y < 0) console.error(`警告: 点击坐标 (${Math.round(x)},${Math.round(y)}) 是负的，可能点不到`);

    // 2) 真实鼠标点击(带用户手势，选择框才会开)
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });

    // 3) 等 fileChooserOpened
    let backendNodeId = null;
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && !backendNodeId) {
      const ev = events.find((e) => e.method === "Page.fileChooserOpened");
      if (ev) backendNodeId = ev.params.backendNodeId || null;
      if (!backendNodeId) await sleep(200);
    }
    if (!backendNodeId) throw new Error("没等到文件选择框事件(点击可能没触发上传按钮)");

    // 4) 把文件交给这个 input
    await send("DOM.setFileInputFiles", { backendNodeId, files: [file] });
    await sleep(Number(opt.wait));

    const after = await send("Runtime.evaluate", { expression: VERIFY, returnByValue: true });
    console.log(
      JSON.stringify({ ok: true, file, clicked: { x, y, w, h, t }, backendNodeId, after: after.result.value }, null, 2)
    );
    ws.close();
  } catch (e) {
    console.error("ERROR:", e.message);
    process.exit(1);
  }
};
