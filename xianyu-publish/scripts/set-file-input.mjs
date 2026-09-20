// 把一个本地文件塞进页面的 <input type=file>。
// 为什么需要单独一个脚本: cdp-eval.mjs 只走 Runtime 域, 而给文件输入框设文件必须走 DOM 域
// (DOM.getDocument(pierce) -> DOM.querySelector -> DOM.setFileInputFiles)。
// nodeId 是会话级的, 所以取节点和设文件必须在同一个连接里完成。
//
// 用法:
//   node set-file-input.mjs --ws <webSocketDebuggerUrl> --file /abs/path/card.jpg
//        [--selector "input[type=file]"] [--index 0] [--wait 3000]
//   CDP_WS / CDP_FILE 环境变量可分别代替 --ws / --file。
//
// 输出 JSON: 选中节点的 tag/属性、设置前后的 files.length, 便于确认真的塞进去了。

const argv = process.argv.slice(2);
const opt = { selector: "input[type=file]", index: "0", wait: "3000" };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) opt[a.slice(2)] = argv[++i];
}

const wsUrl = opt.ws || process.env.CDP_WS;
const file = opt.file || process.env.CDP_FILE;
if (!wsUrl || !file) {
  console.error("需要 --ws(或 CDP_WS) 和 --file(或 CDP_FILE)");
  process.exit(1);
}
if (!file.startsWith("/")) {
  console.error("--file 必须是绝对路径(浏览器进程与页面共享本机文件系统)");
  process.exit(1);
}
const index = Number(opt.index) || 0;
const waitMs = Number(opt.wait) || 3000;

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

const evalIn = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true });
  if (r.exceptionDetails) throw new Error("EXCEPTION: " + JSON.stringify(r.exceptionDetails.exception));
  return r.result.value;
};

ws.onopen = async () => {
  try {
    await send("Runtime.enable");
    await send("DOM.enable");

    const doc = await send("DOM.getDocument", { depth: -1, pierce: true });
    const { nodeId: firstNodeId } = await send("DOM.querySelector", {
      nodeId: doc.root.nodeId,
      selector: opt.selector,
    });
    if (!firstNodeId) throw new Error(`没找到匹配 ${opt.selector} 的元素`);

    let targetNodeId = firstNodeId;
    if (index > 0) {
      // 匹配到多个时按序号取: 用 querySelectorAll 在页面里拿第 index 个, 再回到 DOM 域定位。
      const nth = await evalIn(
        `(()=>{const e=document.querySelectorAll(${JSON.stringify(opt.selector)})[${index}];
                 if(!e) return null; e.setAttribute("data-cdp-file-target","1"); return true;})()`
      );
      if (!nth) throw new Error(`没有第 ${index} 个匹配 ${opt.selector} 的元素`);
      const again = await send("DOM.querySelector", {
        nodeId: doc.root.nodeId,
        selector: '[data-cdp-file-target="1"]',
      });
      if (!again.nodeId) throw new Error("按序号定位失败");
      targetNodeId = again.nodeId;
      await evalIn('document.querySelector("[data-cdp-file-target]").removeAttribute("data-cdp-file-target")');
    }

    const node = (await send("DOM.describeNode", { nodeId: targetNodeId })).node;
    const attrs = {};
    for (let i = 0; i < (node.attributes || []).length; i += 2) attrs[node.attributes[i]] = node.attributes[i + 1];

    const before = await evalIn(
      `(()=>{const e=document.querySelectorAll(${JSON.stringify(opt.selector)})[${index}]; return e?e.files.length:null;})()`
    );

    await send("DOM.setFileInputFiles", { nodeId: targetNodeId, files: [file] });
    await new Promise((r) => setTimeout(r, waitMs));

    const after = await evalIn(
      `(()=>{const e=document.querySelectorAll(${JSON.stringify(opt.selector)})[${index}]; return e?e.files.length:null;})()`
    );

    const pageHint = await evalIn(
      `(()=>{const b=document.body.innerText; return {addDetail:/添加细节图/.test(b), bodyHead:b.replace(/\\n+/g," | ").slice(0,200)};})()`
    );

    console.log(
      JSON.stringify(
        { ok: true, file, selector: opt.selector, index, node: { tag: node.nodeName, attrs }, filesBefore: before, filesAfter: after, page: pageHint },
        null,
        2
      )
    );
    ws.close();
  } catch (e) {
    console.error("ERROR:", e.message);
    process.exit(1);
  }
};
