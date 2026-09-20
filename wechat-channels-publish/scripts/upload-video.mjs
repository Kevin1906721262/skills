// 把本地视频塞进视频号助手(发表动态页)的文件输入框。
//
// 为什么不能直接用 bilibili-publish 的 set-file-input.mjs:
//   1) 视频号是「无界(wujie)微前端」,真实 DOM 在 document.querySelector("wujie-app").shadowRoot
//      里,DOM.querySelector 从 document 根出发**穿不进去**;
//   2) 所以这里先 DOM.getDocument({pierce:true}) 拿到包含 shadowRoots 的完整树,
//      再自己在树里递归找 INPUT[type=file],用命中的 nodeId 调 DOM.setFileInputFiles。
//
// 用法:
//   node upload-video.mjs --ws <ws> --file /abs/x.mp4 [--accept video] [--index 0] [--wait 5000]
//   CDP_WS / CDP_FILE 环境变量可代替 --ws / --file。
//   --accept 按 accept 属性里是否含该子串筛选(默认 video);--index 在筛出的里面取第几个。
//
// 输出 JSON: 命中节点的 accept/multiple 等属性、设置前后的 files.length、页面 video 元素的
//   duration/videoWidth(和源文件对得上才算真的传上去了)。注意 files.length 回 0 不代表失败
//   (框架读完会清空 input),判据永远是页面有没有进入下一步。

const argv = process.argv.slice(2);
const o = { accept: "video", index: "0", wait: "5000", selector: "input[type=file]" };
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith("--")) continue;
  const k = argv[i].slice(2);
  o[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "1";
}
const wsUrl = o.ws || process.env.CDP_WS;
const file = o.file || process.env.CDP_FILE;
if (!wsUrl || !file) {
  console.error("需要 --ws(或 CDP_WS) 和 --file(或 CDP_FILE)");
  process.exit(1);
}
if (!file.startsWith("/")) {
  console.error("--file 必须是绝对路径(浏览器进程与页面共享本机文件系统)");
  process.exit(1);
}
const index = Number(o.index) || 0;
const waitMs = Number(o.wait) || 5000;

const ws = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
  }
};
ws.onerror = (e) => {
  console.error("WS error", e.message || e);
  process.exit(1);
};
const evalIn = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("EVAL: " + JSON.stringify(r.exceptionDetails.exception).slice(0, 300));
  return r.result.value;
};

// 递归遍历 DOM.getDocument(pierce:true) 返回的节点树(children + shadowRoots + contentDocument)
const walk = (node, hit, path = "doc") => {
  const attrs = {};
  for (let i = 0; i < (node.attributes || []).length; i += 2) attrs[node.attributes[i]] = node.attributes[i + 1];
  if (node.nodeName === "INPUT" && (attrs.type || "").toLowerCase() === "file") hit.push({ node, attrs, path });
  (node.children || []).forEach((c) => walk(c, hit, path));
  (node.shadowRoots || []).forEach((c) => walk(c, hit, path + ">shadow"));
  if (node.contentDocument) walk(node.contentDocument, hit, path + ">iframe");
};

const READ_PAGE = `(()=>{const H=document.querySelector("wujie-app");const APP=(H&&H.shadowRoot)||document;
  const v=APP.querySelector("video");
  const inp=[...APP.querySelectorAll("input[type=file]")].map(e=>e.files.length);
  return {url:location.href, fileInputs:inp,
    video: v?{duration:Math.round((v.duration||0)*1000)/1000,w:v.videoWidth,h:v.videoHeight}:null,
    head:(APP.querySelector("body").innerText||"").replace(/\\n+/g," | ").slice(0,300)};})()`;

ws.onopen = async () => {
  try {
    await send("Runtime.enable");
    await send("DOM.enable");
    const doc = await send("DOM.getDocument", { depth: -1, pierce: true });
    const all = [];
    walk(doc.root, all);
    const hit = all.filter((x) => (x.attrs.accept || "").includes(o.accept));
    if (!hit.length) {
      throw new Error(
        `没找到 accept 含 "${o.accept}" 的 input[type=file];页面里共 ${all.length} 个 file input,accept 分别是 ` +
          JSON.stringify([...new Set(all.map((x) => x.attrs.accept || "(无)"))])
      );
    }
    const t = hit[Math.min(index, hit.length - 1)];
    const before = await evalIn(READ_PAGE);
    await send("DOM.setFileInputFiles", { nodeId: t.node.nodeId, files: [file] });
    await new Promise((r) => setTimeout(r, waitMs));
    const after = await evalIn(READ_PAGE);
    console.log(
      JSON.stringify(
        {
          ok: true,
          file,
          matched: hit.length,
          used: { accept: t.attrs.accept, multiple: t.attrs.multiple, path: t.path },
          before,
          after,
        },
        null,
        1
      )
    );
  } catch (e) {
    console.error("ERROR:", e.message);
    process.exit(1);
  } finally {
    ws.close();
    process.exit(0);
  }
};
setTimeout(() => {
  console.error("TIMEOUT");
  process.exit(4);
}, 120000);
