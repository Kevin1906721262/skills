#!/usr/bin/env node
/**
 * feishu.mjs — 通过 CDP 驱动已登录的 Chrome,读写飞书云文档(docx / wiki 页面)。
 *
 * 设计要点(踩过的坑见 ../references/feishu-docx-dom.md):
 *   - 富文本写入走"系统剪贴板 + 真实 Cmd+V",不用 DOM 注入;HTML 由 setclip.sh 提供 text/html flavor。
 *   - 正文是虚拟列表,DOM 里只有可视块 → outline/text 会滚动分片收集。
 *   - 插入位置 = 当前光标;每步粘贴后光标停在末尾,所以"文本段→图片→文本段"顺序追加是可靠的。
 *
 * 全局参数: --port=9222 | --doc=<token> | --tab=<url 子串> | --first | --yes
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const SETCLIP = resolve(HERE, "setclip.sh");

const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (const a of argv) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) flags[m[1]] = m[2] === undefined ? true : m[2];
  else positional.push(a);
}
const [cmd, ...rest] = positional;
const PORT = Number(flags.port || process.env.CDP_PORT || 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (v) => console.log(JSON.stringify(v, null, 1));

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

async function httpJson(path, init) {
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${PORT}${path}`, init);
  } catch {
    die(`连不上 Chrome 调试口 127.0.0.1:${PORT}。先按 chrome-cdp-drive skill §1 检查/启动自动化 Chrome。`);
  }
  return res.json();
}

/** 找到目标标签页:默认挑飞书页面,可用 --doc / --tab 收敛 */
async function pickTarget() {
  const targets = await httpJson("/json");
  const pages = targets.filter(
    (t) => t.type === "page" && t.url.startsWith("http") && !t.url.startsWith("chrome")
  );
  let pool = pages;
  if (flags.tab) pool = pages.filter((t) => t.url.includes(String(flags.tab)));
  else pool = pages.filter((t) => /(feishu\.(cn|com)|larksuite\.com)/.test(t.url));
  if (flags.doc) pool = pool.filter((t) => t.url.includes(String(flags.doc)));

  if (pool.length === 0) {
    die(
      "没找到匹配的标签页。现有页面:\n" +
        pages.map((t) => `  ${t.url}`).join("\n") +
        "\n可用 `open <url>` 先打开文档,或用 --tab=<url 子串> 指定。"
    );
  }
  if (pool.length > 1 && !flags.first) {
    die(
      `匹配到 ${pool.length} 个标签页,请用 --doc=<token> 或 --tab=<子串> 指定:\n` +
        pool.map((t) => `  ${t.url}`).join("\n")
    );
  }
  return pool[0];
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      }
    };
  }
  send(method, params = {}) {
    return new Promise((res, rej) => {
      const id = ++this.id;
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  async click(x, y) {
    const base = { x, y, button: "left", clickCount: 1, modifiers: 0 };
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...base });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
  }
  async key(spec) {
    const { params, up } = keyParams(spec);
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...params });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...up });
    await sleep(Number(flags["key-wait"] || 350));
  }
  async paste(waitMs) {
    await this.key("meta+v");
    await sleep(waitMs ?? Number(flags.wait || 1800));
  }
}

const KEYS = {
  v: { key: "v", code: "KeyV", vk: 86, native: 9, command: "Paste" },
  a: { key: "a", code: "KeyA", vk: 65, native: 0, command: "SelectAll" },
  c: { key: "c", code: "KeyC", vk: 67, native: 8, command: "Copy" },
  x: { key: "x", code: "KeyX", vk: 88, native: 7, command: "Cut" },
  z: { key: "z", code: "KeyZ", vk: 90, native: 6, command: "Undo" },
  f: { key: "f", code: "KeyF", vk: 70, native: 3 },
  enter: { key: "Enter", code: "Enter", vk: 13, native: 36 },
  delete: { key: "Delete", code: "Delete", vk: 46, native: 117 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8, native: 51 },
  escape: { key: "Escape", code: "Escape", vk: 27, native: 53 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40, native: 125 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38, native: 126 },
};

async function openCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const cdp = new Cdp(ws);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("WebSocket 连接失败"));
  });
  return cdp;
}

function keyParams(spec) {
  const parts = spec.toLowerCase().split("+");
  const name = parts.pop();
  const k = KEYS[name];
  if (!k) die(`未知按键: ${name}(可用: ${Object.keys(KEYS).join(", ")})`);
  let modifiers = 0;
  if (parts.includes("meta") || parts.includes("cmd")) modifiers |= 4;
  if (parts.includes("shift")) modifiers |= 8;
  if (parts.includes("alt")) modifiers |= 1;
  if (parts.includes("ctrl")) modifiers |= 2;
  const up = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.native, modifiers };
  const params = { ...up };
  if (k.command && modifiers === 4) params.commands = [k.command]; // 关键:让 Chromium 直接执行编辑命令
  return { params, up };
}

// ---------- 页面探针 ----------

const META = `(()=>{
  const strip = s => (s||'').replace(/[\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\ufeff\\u00ad]/g,'').trim();
  // 标题元素可能有多层包装(外层含"添加图标/添加封面"),取最短且干净的那个
  const cands = [...document.querySelectorAll('h1,[class*=docx-title],[class*=title-block]')]
    .map(e => strip(e.textContent || ''))
    .filter(t => t && t.length < 90 && !/飞书云文档|添加图标|添加封面|今天修改/.test(t))
    .sort((a, b) => a.length - b.length);
  const editable = document.querySelector('[contenteditable=true]');
  return {
    url: location.href,
    docTitle: strip(document.title.replace(/\\s*[-–]\\s*飞书云文档\\s*$/,'')),
    headingText: cands[0] || null,
    editable: !!editable,
    readOnly: !editable,
  };
})()`;

const BLOCK_DUMP = `(()=>{
  const root = document.querySelector('[contenteditable=true]');
  const sc = document.querySelector('.bear-web-x-container');
  if (!root) return {error: '找不到正文编辑区(文档可能只读,或还没加载完)'};
  const base = sc ? sc.getBoundingClientRect().top - sc.scrollTop : 0;
  const strip = s => (s||'').replace(/[\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\ufeff\\u00ad]/g,'').replace(/\\s+/g,' ').trim();
  return [...root.querySelectorAll('.block')].filter(b => b.getBoundingClientRect().height > 4).map(b => {
    const r = b.getBoundingClientRect();
    const img = b.querySelector('img');
    const text = strip(b.innerText);
    return {
      type: (typeof b.className === 'string' ? b.className : '').replace('block','').replace('docx-','').trim().replace(/-/g,'_'),
      text: text.slice(0, 120),
      image: img ? (img.currentSrc || img.src).slice(0, 64) : null,
      y: Math.round(r.top - base),
      h: Math.round(r.height),
    };
  });
})()`;

/** 光标探针:返回光标所在的块、块内字符偏移、是否在文末 */
const CARET = `(()=>{
  const sel = getSelection();
  if (!sel || !sel.anchorNode) return {error: 'no selection'};
  const node = sel.anchorNode;
  const el = node.nodeType === 3 ? node.parentElement : node;
  const block = el && el.closest ? el.closest('.block') : null;
  if (!block) return {error: 'caret not in a block'};
  const range = document.createRange();
  range.selectNodeContents(block);
  range.setEnd(node, sel.anchorOffset);
  const blocks = [...document.querySelectorAll('[contenteditable=true] .block')];
  const text = (block.textContent || '').replace(/[\\u200b-\\u200f\\ufeff]/g, '');
  return {
    offset: range.toString().replace(/[\\u200b-\\u200f\\ufeff]/g, '').length,
    blockLength: text.length,
    atBlockEnd: range.toString().replace(/[\\u200b-\\u200f\\ufeff]/g, '').length >= text.length,
    isLastBlock: block === blocks[blocks.length - 1],
    blockType: (typeof block.className === 'string' ? block.className : '').slice(0, 40),
    blockText: text.slice(0, 40),
  };
})()`;

/** 文末最后一个块的位置与类型 */
const LAST_BLOCK = `(()=>{
  const bs = [...document.querySelectorAll('[contenteditable=true] .block')];
  const b = bs[bs.length - 1];
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return {
    x: Math.round(r.x), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom),
    h: Math.round(r.height), isImage: !!b.querySelector('img'),
    empty: !(b.textContent || '').replace(/[\\u200b-\\u200f\\ufeff\\s]/g, ''),
    type: (typeof b.className === 'string' ? b.className : '').slice(0, 40),
  };
})()`;

/** 滚动全文收集块:虚拟列表里只有可视块在 DOM,必须分片扫;同位置(±15px)视为同一块 */
async function collectBlocks(cdp) {
  const height = await cdp.eval(
    `(()=>{const c=document.querySelector('.bear-web-x-container');return c?c.scrollHeight:0;})()`
  );
  const seen = new Map(); // key -> [y...]
  const rows = new Map(); // key+y -> row
  const step = 420;
  for (let y = 0; y <= height + step; y += step) {
    await cdp.eval(`(()=>{const c=document.querySelector('.bear-web-x-container');if(c)c.scrollTop=${y};return 1;})()`);
    await sleep(380);
    const batch = await cdp.eval(BLOCK_DUMP);
    if (batch.error) throw new Error(batch.error);
    for (const b of batch) {
      const key = `${b.type}|${b.text}|${b.image || ""}`;
      const ys = seen.get(key) || [];
      if (ys.some((v) => Math.abs(v - b.y) < 15)) continue;
      ys.push(b.y);
      seen.set(key, ys);
      rows.set(`${key}|${b.y}`, b);
    }
  }
  return [...rows.values()].sort((a, b) => a.y - b.y);
}

/** 定位包含指定文本的最小块,返回落点坐标(start=首行左端 / end=末行右端 / center=中心) */
async function findSpot(cdp, text, where = "end") {
  return cdp.eval(`(()=>{
    const strip = s => (s||'').replace(/[\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\ufeff\\u00ad]/g,'').replace(/\\s+/g,' ').trim();
    const cands = [...document.querySelectorAll('[contenteditable=true] .block')]
      .filter(e => strip(e.innerText).includes(${JSON.stringify(text)}))
      .filter(e => { const r = e.getBoundingClientRect(); return r.width > 30 && r.height > 5; });
    const e = cands.sort((a,b)=>a.getBoundingClientRect().height-b.getBoundingClientRect().height)[0];
    if (!e) return null;
    const r = e.getBoundingClientRect();
    const x = ${where === "center"} ? r.x + r.width/2 : (${where === "start"} ? r.x + 8 : r.x + r.width - 20);
    const y = ${where === "center"} ? r.y + r.height/2 : (${where === "start"} ? r.y + 6 : r.bottom - 6);
    return { x: Math.round(x), y: Math.round(y), cls: (typeof e.className === 'string' ? e.className : '').slice(0,40) };
  })()`);
}

/**
 * 把光标放到"文末的空段落"里 —— 结构化 HTML 只有粘进空段落才会展开成多个块,
 * 否则会被拍平并进光标所在的当前块(标题块尤其明显)。返回 ready 表示可以安全追加。
 */
async function ensureAppendPoint(cdp) {
  await cdp.eval(`(()=>{const c=document.querySelector('.bear-web-x-container');if(c)c.scrollTop=c.scrollHeight;return 1;})()`);
  await sleep(700);

  let last = await cdp.eval(LAST_BLOCK);
  if (!last) return { ready: false, reason: "找不到正文块(文档可能只读或未加载完)" };

  if (last.isImage) { // 图片块后面没有可落光标的文本块时,回车补一个
    await cdp.click(last.x + 80, last.top + last.h / 2);
    await sleep(400);
    await cdp.key("enter");
    await sleep(600);
    last = await cdp.eval(LAST_BLOCK);
  }

  const spots = [
    [last.right - 20, last.bottom - 6],
    [last.right - 20, last.bottom - 12],
    [last.right - 40, last.bottom - 4],
  ];
  let caret = null;
  for (const [x, y] of spots) {
    await cdp.click(x, y);
    await sleep(400);
    caret = await cdp.eval(CARET);
    if (caret && caret.isLastBlock && caret.atBlockEnd) break;
  }
  const atEnd = !!(caret && caret.isLastBlock && caret.atBlockEnd);

  let opened = false;
  if (atEnd && !last.empty) {
    await cdp.key("enter"); // 在块尾回车开一个空段落
    await sleep(500);
    opened = true;
  }
  const after = await cdp.eval(LAST_BLOCK);
  const ready = !!(atEnd && after && after.empty && !after.isImage);
  return { ready, atEnd, opened, lastBlock: after, caret };
}

async function waitForEditor(cdp, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await cdp.eval(
      `(()=>{const r=document.querySelector('[contenteditable=true]');return !!(r && r.querySelector('.block'));})()`
    );
    if (ok) {
      await sleep(1200); // 等渲染与同步稳定
      return true;
    }
    await sleep(500);
  }
  return false;
}

// ---------- 剪贴板 ----------

function clipHtml(htmlFile, textFile) {
  const argv = ["bash", SETCLIP, "html", htmlFile];
  if (textFile) argv.push(textFile);
  return execFileSync(argv[0], argv.slice(1)).toString().trim();
}

function clipPng(file) {
  if (!existsSync(file)) die(`图片不存在: ${file}`);
  return execFileSync("bash", [SETCLIP, "png", file]).toString().trim();
}

// ---------- 主流程 ----------

async function main() {
  if (!cmd || cmd === "help") {
    console.log(`用法: node feishu.mjs <命令> [参数] [--port=9222] [--doc=<token>] [--tab=<url 子串>] [--first]

读:
  tabs                          列出可用的浏览器标签页
  title                         文档标题 + URL + 是否可编辑
  text                          全文纯文本(滚动收集)
  blocks                        当前可视块的类型/文本/位置(快)
  outline                       全文块结构(滚动收集,慢但完整)
  imgs                          全文图片列表(位置/尺寸/URL)
  eval '<js>'                   在页面里执行任意 JS

写:
  open <url>                    新开标签页并等待加载
  focus-end                     把光标放到正文末尾
  click <文本> [end|center]     点击包含该文本的最小块
  insert <文本>                 在光标处插入纯文本(不经过剪贴板)
  key <组合键>...               派发按键,如 key meta+a delete enter
  clip-html <htmlFile|-> [textFile]   把 HTML(+纯文本) 放进系统剪贴板
  clip-png <pngFile>            把图片放进系统剪贴板
  paste                         派发 Cmd+V
  write <plan.json>             按计划顺序追加图文(见 SKILL.md)
  remove <文本>                 删除包含该文本的块(清空 + 退格合并)
  clear --yes                   清空正文(Cmd+A ×2 + Delete,危险)
  reload                        重新加载页面并等待正文就绪`);
    process.exit(0);
  }

  if (cmd === "tabs") {
    const targets = await httpJson("/json");
    out(
      targets
        .filter((t) => t.type === "page" && t.url.startsWith("http"))
        .map((t) => ({ title: t.title, url: t.url, id: t.id }))
    );
    return;
  }

  if (cmd === "open") {
    const url = rest[0] || die("用法: open <url>");
    const t = await httpJson(`/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
    const cdp = await openCdp(t.webSocketDebuggerUrl);
    await sleep(500);
    await waitForEditor(cdp);
    out({ opened: url, id: t.id });
    process.exit(0);
  }

  const target = await pickTarget();
  const cdp = await openCdp(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.bringToFront");
  await sleep(300);

  switch (cmd) {
    case "title":
    case "meta":
      out(await cdp.eval(META));
      break;

    case "blocks":
      out(await cdp.eval(BLOCK_DUMP));
      break;

    case "outline":
      out(await collectBlocks(cdp));
      break;

    case "text": {
      const blocks = await collectBlocks(cdp);
      out({ text: blocks.map((b) => b.text).filter(Boolean).join("\n") });
      break;
    }

    case "imgs": {
      const blocks = await collectBlocks(cdp);
      out(blocks.filter((b) => b.image));
      break;
    }

    case "eval":
      out(await cdp.eval(rest.join(" ")));
      break;

    case "click": {
      const text = rest[0] || die("用法: click <文本> [end|center]");
      const where = rest[1] || "end";
      const spot = await findSpot(cdp, text, where);
      if (!spot) die(`没找到包含该文本的块: ${text}(可能需要先滚动到它附近)`);
      await cdp.click(spot.x, spot.y);
      await sleep(500);
      out({ clicked: text, ...spot });
      break;
    }

    case "focus-end": {
      const ap = await ensureAppendPoint(cdp);
      if (!ap.ready) console.error(`注意:没能把光标放到文末空段落,粘贴可能被拍平进当前段落: ${JSON.stringify(ap)}`);
      out({ focused: ap.ready ? "end-empty-block" : "unsure", ...ap });
      process.exit(ap.ready ? 0 : 4);
    }

    case "remove": {
      // 删除包含指定文本的块:清空块内容 → 退格合并掉空块;标题块需要多退一次(先降级成段落)
      const text = rest.join(" ") || die("用法: remove <文本>");
      const log = [];
      let removed = false;
      for (let attempt = 0; attempt < 3 && !removed; attempt++) {
        const spot = await findSpot(cdp, text, "start");
        if (!spot) { removed = true; break; }
        await cdp.click(spot.x, spot.y);
        await sleep(400);
        await cdp.key("meta+a");
        await cdp.key("delete");
        await cdp.key("backspace");
        // 文本消失 ≠ 块消失:标题块要先退化成段落,空块还要再退一次才会并掉,所以循环到"文本没了 + 光标不在空块里"
        for (let i = 0; i < 4; i++) {
          const gone = !(await findSpot(cdp, text, "start"));
          const caret = await cdp.eval(CARET);
          const stillEmpty = !!(caret && !caret.error && !caret.blockText);
          if (gone && !stillEmpty) { removed = true; break; }
          await cdp.key("backspace");
        }
        log.push({ attempt: attempt + 1, cls: spot.cls, removed });
      }
      out({ removed, text, log });
      process.exit(removed ? 0 : 4);
    }

    case "insert": {
      const text = rest.join(" ");
      await cdp.send("Input.insertText", { text });
      await sleep(500);
      out({ inserted: text.length });
      break;
    }

    case "key":
      for (const spec of rest) await cdp.key(spec);
      out({ keys: rest });
      break;

    case "clip-html":
      if (rest[0] === "-") {
        const html = readFileSync(0, "utf8");
        const r = execFileSync("bash", [SETCLIP, "html", "-"], { input: html }).toString().trim();
        out({ result: r });
      } else {
        out({ result: clipHtml(rest[0], rest[1]) });
      }
      break;

    case "clip-png":
      out({ result: clipPng(rest[0]) });
      break;

    case "paste":
      await cdp.paste();
      out({ pasted: true });
      break;

    case "clear": {
      if (!flags.yes) die("clear 会清空整篇正文。确认后重跑: clear --yes");
      await cdp.key("meta+a");
      await cdp.key("meta+a");
      await cdp.key("delete");
      await sleep(800);
      out({ cleared: true, blocks: (await cdp.eval(BLOCK_DUMP)).length });
      break;
    }

    case "reload":
      await cdp.eval(`location.reload(), 1`);
      await sleep(3000);
      out({ ready: await waitForEditor(cdp), ...(await cdp.eval(META)) });
      break;

    case "write":
      out(await runPlan(cdp, rest[0] || die("用法: write <plan.json>")));
      break;

    default:
      die(`未知命令: ${cmd}(node feishu.mjs help 看用法)`);
  }
  process.exit(0);
}

/** 按 plan.json 顺序把图文追加到文末:每一步粘贴后光标都在末尾 */
async function runPlan(cdp, planPath) {
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  const steps = plan.steps || plan;
  const base = dirname(resolve(planPath));
  const htmlWait = plan.waits?.html ?? 1800;
  const pngWait = plan.waits?.png ?? 6000;
  const log = [];
  let blocked = 0;

  for (const [i, step] of steps.entries()) {
    const label = `#${i + 1}`;
    if (step.wait) {
      await sleep(step.wait);
      log.push({ step: label, waited: step.wait });
      continue;
    }
    if (step.key) {
      for (const k of [].concat(step.key)) await cdp.key(k);
      log.push({ step: label, key: step.key });
    }
    if (step.png || step.html || step.text) {
      // 关键不变量:粘贴前必须把光标停到文末空段落,否则内容会被拍平进当前块
      const ap = await ensureAppendPoint(cdp);
      if (!ap.ready) blocked++;
      log.push({ step: label, appendPoint: ap.ready ? "ok" : ap });
    }
    if (step.png) {
      const file = resolve(base, step.png);
      clipPng(file);
      await cdp.paste(pngWait);
      log.push({ step: label, png: file });
    }
    if (step.html || step.text) {
      let html = step.html;
      // text 步骤按纯文本处理:转义 HTML 特殊字符,避免正文里的 < > & 被解析成标签
      if (!html) {
        const esc = String(step.text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        html = `<p>${esc}</p>`;
      }
      if (existsSync(resolve(base, html))) html = readFileSync(resolve(base, html), "utf8");
      const tmp = resolve(tmpdir(), `feishu-step-${Date.now()}.html`);
      writeFileSync(tmp, html, "utf8");
      const r = execFileSync("bash", [SETCLIP, "html", tmp]).toString().trim();
      await cdp.paste(htmlWait);
      log.push({ step: label, html: html.slice(0, 60), clipboard: r });
    }
  }
  return { steps: steps.length, blockedAppendPoints: blocked, log };
}

main().catch((e) => die(`ERROR: ${e.message}`, 3));
