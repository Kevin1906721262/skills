#!/usr/bin/env node
/**
 * 驱动公众号图文编辑器:开新文章、填标题、粘正文与图片、存草稿、验收草稿箱。
 *
 * 用法: node wx.mjs <命令> [参数] [--port=9222] [--tab=<编辑器 URL 子串>] [--list=<草稿箱 URL 子串>] [--first]
 *
 * 读:
 *   tabs                        列出浏览器标签页
 *   status                      标题 / 正文块 / 图片数 / 字数 / 保存状态
 *
 * 写:
 *   open                        从草稿箱列表页点「新的创作 → 文章」,等新编辑器页签
 *   title <文本>                设置标题(覆盖已有标题)
 *   paste <file.html|file.png>  写进系统剪贴板 + 在正文里 Cmd+V(粘前自动聚焦正文)
 *   text  <纯文本>              同上,自动包成 <p>
 *   write <plan.json>           按计划顺序追加图文(见 references/editor-dom.md)
 *   clear --yes                 清空正文(Cmd+A + Delete,危险)
 *   focus-end                   光标放到正文末尾(追加粘贴前的对齐点)
 *   click <文本> [start|end|center]  点击含该文本的正文块,用于中途插入
 *   key <组合键>...             派发按键,如 key meta+a delete enter
 *   insert <文本>               在光标处插入纯文本(不经过剪贴板)
 *   format                      一键排版:开排版页签 → 选默认样式 → 使用此排版
 *   orig [作者名]               声明原创(默认作者「奉钦」,已声明则跳过)
 *   finish [作者名]             format → orig → save 一条龙(已做过的步骤自动跳过)
 *   save                        点「保存为草稿」
 *   drafts                      重载草稿箱列表,回读草稿标题与更新时间
 *
 * 说明: format/finish 里的「一键排版」会新开一个页签,排版完成后**后续操作一律切到那个新页签**
 *       (旧页签是排版前的内存状态),脚本会自动切并把页签缓存指过去。
 *
 * 覆盖默认值: --author=<作者名>(orig/finish 的原创作者,默认「奉钦」);
 *             --force(format 已排版时强制重排、orig 已声明时重开弹窗);
 *             --no-format / --no-orig(finish 里跳过对应步骤)
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SETCLIP = resolve(HERE, "setclip.sh");
// 记住最近一次 open 出来的编辑器页签:否则浏览器里同时留着旧编辑器页签时,
// 后续 status/paste/save 会因"匹配到多个页签"而卡住。
const CACHE = `${process.env.XDG_CACHE_HOME || `${process.env.HOME}/.cache`}/wechat-mp-draft`;
const LAST_EDITOR = `${CACHE}/last-editor.json`;

// 编辑器与草稿箱的 URL 特征(2026-09 实测;改版时先 `tabs` 看实际 URL)
const EDITOR_HINT = "appmsg_edit";
const LIST_HINT = "list_card";
const LAYOUT_HINT = "articlestruct"; // 「一键排版」临时页签
const BODY_SEL = ".rich_media_content .ProseMirror"; // 正文(ProseMirror)
const TITLE_SEL = ".title-editor__input .ProseMirror"; // 可见的标题编辑器
const DEFAULT_AUTHOR = "奉钦"; // 声明原创时默认填的作者

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const flags = {};
const rest = [];
for (const a of argv) {
  const m = /^--([^=]+)(?:=([\s\S]*))?$/.exec(a);
  if (m) flags[m[1]] = m[2] === undefined ? true : m[2];
  else rest.push(a);
}
const cmd = rest.shift();
const PORT = flags.port || 9222;
const TAB = flags.tab || EDITOR_HINT;
const LIST = flags.list || LIST_HINT;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (o) => console.log(JSON.stringify(o, null, 1));
const die = (m) => {
  console.error(m);
  process.exit(1);
};

// ---------- CDP ----------
const KEYS = {
  v: { key: "v", code: "KeyV", vk: 86, native: 9, command: "Paste" },
  a: { key: "a", code: "KeyA", vk: 65, native: 0, command: "SelectAll" },
  c: { key: "c", code: "KeyC", vk: 67, native: 8, command: "Copy" },
  z: { key: "z", code: "KeyZ", vk: 90, native: 6, command: "Undo" },
  enter: { key: "Enter", code: "Enter", vk: 13, native: 36 },
  delete: { key: "Delete", code: "Delete", vk: 46, native: 117 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8, native: 51 },
  escape: { key: "Escape", code: "Escape", vk: 27, native: 53 },
};

function keyParams(spec) {
  const parts = spec.toLowerCase().split("+");
  const k = KEYS[parts.pop()];
  if (!k) die(`未知按键: ${spec}`);
  let modifiers = 0;
  if (parts.includes("meta") || parts.includes("cmd")) modifiers |= 4;
  if (parts.includes("shift")) modifiers |= 8;
  if (parts.includes("alt")) modifiers |= 1;
  if (parts.includes("ctrl")) modifiers |= 2;
  const up = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.native, modifiers };
  const params = { ...up };
  // 关键:组合键带 command 才会被 Chromium 当成编辑命令执行(裸按键事件不触发粘贴/全选)
  if (k.command && modifiers === 4) params.commands = [k.command];
  return { params, up };
}

async function httpJson(path, init) {
  return (await fetch(`http://127.0.0.1:${PORT}${path}`, init)).json();
}

async function pages() {
  const all = await httpJson("/json").catch(() => null);
  if (!all) die(`连不上调试端口 ${PORT}。先看 skill chrome-cdp-drive §0/§1。`);
  return all.filter((t) => t.type === "page" && t.url.startsWith("http"));
}

async function pick(hint, what) {
  const ps = await pages();
  if (hint === TAB && !flags.tab) {
    try {
      const { id } = JSON.parse(readFileSync(LAST_EDITOR, "utf8"));
      const hit = ps.find((t) => t.id === id);
      if (hit) return hit;
    } catch {}
  }
  const pool = ps.filter((t) => t.url.includes(hint));
  if (!pool.length) {
    die(
      `没找到${what}(URL 含 "${hint}")。现有页面:\n` +
        ps.map((t) => "  " + t.url).join("\n") +
        `\n先在浏览器里打开公众号后台对应页面,或用 --tab= / --list= 指定。`
    );
  }
  if (pool.length > 1 && !flags.first) {
    die(
      `匹配到 ${pool.length} 个${what},用 --tab= / --list= 收敛,或 --first 取第一个:\n` +
        pool.map((t) => "  " + t.url).join("\n")
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
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      }
    };
  }
  send(method, params = {}) {
    return new Promise((res, rej) => {
      const id = ++this.id;
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  async click(x, y) {
    const b = { x, y, button: "left", clickCount: 1, modifiers: 0 };
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...b });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...b });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...b });
  }
  async key(spec) {
    const { params, up } = keyParams(spec);
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...params });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...up });
    await sleep(Number(flags["key-wait"] || 350));
  }
  async paste(waitMs) {
    await this.key("meta+v");
    await sleep(waitMs);
  }
  async insertText(text) {
    await this.send("Input.insertText", { text });
    await sleep(300);
  }
  /**
   * 逐字派发真实按键事件。Input.insertText 只改 DOM 的 value,不触发框架的 input 事件
   * (公众号后台的表单是 Vue,写完计数还是 0/8、提交时报"作者不能为空")——所以表单字段一律用这个。
   */
  async typeText(text) {
    for (const ch of text) {
      await this.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch });
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
      await sleep(50);
    }
    await sleep(300);
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function openCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const cdp = new Cdp(ws);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("WebSocket 连接失败"));
  });
  return cdp;
}

// ---------- 页面探针 ----------
const j = (v) => JSON.stringify(v);

const STATE = `(()=>{
  const body = document.querySelector(${j(BODY_SEL)});
  const titleEl = document.querySelector(${j(TITLE_SEL)});
  const ta = document.querySelector("#title");
  const blocks = body ? [...body.children] : [];
  const content = blocks.filter(el => (el.textContent||"").trim() || el.querySelector("img"));
  // 注意:ProseMirror 会给每个块塞一个 <img class="ProseMirror-separator" src=""> 占位,别把它算成图片
  const realImg = i => /^(https?:|data:)/.test(i.getAttribute("src") || "");
  return {
    url: location.href,
    title: titleEl ? (titleEl.innerText||"").trim() : (ta ? (ta.value||"").trim() : null),
    chars: body ? (body.innerText||"").split("").filter(c=>c.trim()).length : 0,
    contentBlocks: content.length,
    images: body ? [...body.querySelectorAll("img")].filter(realImg).length : 0,
    // 「一键排版」会把 <p> 换成带 data-layout-id/style 的 <section>,拿它判断排过没
    layouted: !!(body && body.querySelector("[data-layout-id]")),
    // 底部「原创」:未声明块和已声明块都在 DOM 里,靠 display 判断现在生效的是哪个
    // (别读 #js_original 的 innerText:它整块可能没被渲染,innerText 会退化成 textContent,把两个块粘一起)
    original: (()=>{
      const g = document.querySelector("#js_original");
      if (!g) return null;
      const open = g.querySelector("#js_original_open");
      if (open && getComputedStyle(open).display !== "none") {
        const t = (open.querySelector(".setting-group__switch-tips") || open).textContent || "";
        return (t.replace(/\\s+/g," ").trim() || "已声明").slice(0,60);
      }
      return "未声明";
    })(),
    saves: ((document.body.innerText||"").match(/[^\\n]*保存[^\\n]*/g)||[]).slice(0,3),
  };
})()`;

/** 「一键排版」页签:等「使用此排版」出现,并回读当前选中的样式/主题色 */
const BODY_TEXT = `(()=>{const b=document.querySelector(${j(BODY_SEL)});return b ? (b.innerText||"") : "";})()`;

/** 「一键排版」前后比正文,按句子报出差异,给你核对(排版、或你同时在编辑,都会让这里出现条目) */
function diffText(before, after) {
  const norm = (s) => String(s || "").replace(/\s+/g, "");
  const nBefore = norm(before);
  const nAfter = norm(after);
  const dropped = [];
  for (const raw of String(before || "").split(/(?<=[。！？!?；;])|\n/)) {
    const s = norm(raw);
    if (s.length < 8) continue;
    if (!nAfter.includes(s)) dropped.push(s.slice(0, 40));
  }
  return { charsBefore: nBefore.length, charsAfter: nAfter.length, dropped };
}

const LAYOUT_PROBE = `(()=>{
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
  const save = [...document.querySelectorAll(".article_layout-save")].filter(vis)[0];
  const styles = [...document.querySelectorAll(".layoutstyle_item")].filter(vis);
  const colors = [...document.querySelectorAll(".themecolor-item_wrp")].filter(vis);
  return {
    ready: !!save,
    styles: styles.map(e => String(e.className).replace(/\\s+/g," ")),
    styleSelected: styles.findIndex(e => /\\bselected\\b/.test(e.className)),
    colorSelected: colors.findIndex(e => /\\bselected\\b/.test(e.className)),
  };
})()`;

/** 原创声明弹窗:必须只看可见的那个(页面里常驻几个隐藏弹窗,按类名取第一个会取错) */
const ORIG_PROBE = `(()=>{
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const d = [...document.querySelectorAll(".weui-desktop-dialog")].filter(vis)
    .find(e => (e.innerText||"").includes("声明类型"));
  if (!d) return null;
  const inputs = [...d.querySelectorAll("input.js_author")].filter(vis);
  const nameInput = inputs[0] || null;
  const agree = [...d.querySelectorAll("input.weui-desktop-form__checkbox")].filter(vis)[0] || null;
  const radio = [...d.querySelectorAll("input.js_original_type_radio")].filter(vis)
    .map(i => ({ value: i.value, checked: i.checked })).find(r => r.checked || r.value === "0");
  const ok = [...d.querySelectorAll("button")].filter(vis).find(b => (b.innerText||"").trim() === "确定");
  const nr = nameInput ? nameInput.getBoundingClientRect() : null;
  return {
    found: true, hasName: !!nameInput, hasOk: !!ok,
    name: nameInput ? nameInput.value : null,
    nameAt: nr ? { x: Math.round(nr.left + nr.width/2), y: Math.round(nr.top + nr.height/2) } : null,
    agree: agree ? agree.checked : null,
    type: radio ? radio.value : null,
    text: (d.innerText||"").replace(/\\s+/g," ").slice(0,160),
  };
})()`;

/** 点击候选元素:默认取面积最小的叶子节点,避免点到外层容器 */
async function clickEl(cdp, { selector, text = null, exact = true, wrap = null }) {
  const cond =
    text === null ? "" : `.filter(x=>(x.textContent||"").trim() ${exact ? "===" : "includes"} ${j(text)})`;
  const spot = await cdp.eval(`(()=>{
    const vis = e => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4; };
    let c = [...document.querySelectorAll(${j(selector)})].filter(vis)${cond};
    let e = c.sort((a,b)=>{const ra=a.getBoundingClientRect(),rb=b.getBoundingClientRect();return ra.width*ra.height-rb.width*rb.height;})[0];
    if (!e) return null;
    ${wrap ? `const w = e.closest(${j(wrap)}); if (w) e = w;` : ""}
    e.scrollIntoView({block:"center",inline:"center"});
    const r = e.getBoundingClientRect();
    return { tag:e.tagName, cls:String(e.className).slice(0,60), text:(e.textContent||"").trim().slice(0,30),
             x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2), w:Math.round(r.width), h:Math.round(r.height) };
  })()`);
  if (!spot) return null;
  await cdp.click(spot.x, spot.y);
  return spot;
}

/** 求值出一个 {x,y} 坐标点后真实点击(用于要点「第几个」元素的场景) */
async function clickSpot(cdp, spotExpr) {
  const spot = await cdp.eval(spotExpr);
  if (!spot) return null;
  await cdp.click(spot.x, spot.y);
  return spot;
}

/** 轮询等一个探针满足条件 */
async function waitFor(cdp, expr, ok, tries = 30, ms = 500) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    last = await cdp.eval(expr).catch(() => null);
    if (last && ok(last)) return last;
    await sleep(ms);
  }
  return last;
}

const CARET = `(()=>{
  const s = getSelection();
  if (!s || !s.anchorNode) return { error: "no-selection" };
  const n = s.anchorNode;
  const el = n.nodeType === 3 ? n.parentElement : n;
  const body = document.querySelector(${j(BODY_SEL)});
  return { inBody: !!(body && body.contains(el)), tag: el.tagName, offset: s.anchorOffset,
           text: (el.textContent||"").slice(0,30) };
})()`;

async function bodyHasFocus(cdp) {
  return cdp.eval(`(()=>{const b=document.querySelector(${j(BODY_SEL)});return !!(b&&b.contains(document.activeElement));})()`);
}

/** 粘之前保证焦点在正文里;正文为空时用真实点击唤醒编辑器 */
async function focusBody(cdp) {
  if (await bodyHasFocus(cdp)) return "already-focused";
  const empty = await cdp.eval(
    `(()=>{const b=document.querySelector(${j(BODY_SEL)});return !!b && !(b.innerText||"").trim();})()`
  );
  if (empty) {
    const s = await clickEl(cdp, { selector: BODY_SEL });
    return s ? "clicked-empty-body" : "no-body";
  }
  await cdp.eval(`(()=>{document.querySelector(${j(BODY_SEL)}).focus();return 1;})()`);
  return "focused";
}

// ---------- 剪贴板 ----------
function setClipHtml(html, textFile) {
  const args = ["bash", SETCLIP, "html", "-"];
  if (textFile) args.push(textFile);
  return execFileSync(args[0], args.slice(1), { input: html }).toString().trim();
}
function setClipHtmlFile(file) {
  if (!existsSync(file)) die(`文件不存在: ${file}`);
  return execFileSync("bash", [SETCLIP, "html", file]).toString().trim();
}
function setClipPng(file) {
  if (!existsSync(file)) die(`图片不存在: ${file}`);
  return execFileSync("bash", [SETCLIP, "png", file]).toString().trim();
}
function clipFor(file) {
  return /\.(png|jpe?g)$/i.test(file) ? setClipPng(file) : setClipHtmlFile(file);
}

const KNOWN_STEPS = new Set(["html", "png", "text", "key", "wait", "click", "focusEnd"]);

// ---------- 主流程 ----------
async function main() {
  if (!cmd || cmd === "help") {
    console.log(
      readFileSync(fileURLToPath(import.meta.url), "utf8")
        .split("*/")[0]
        .split("/**")[1]
        .split("\n")
        .map((l) => l.replace(/^\s*\*? ?/, "").replace(/\s+$/, ""))
        .join("\n")
        .trim()
    );
    process.exit(0);
  }

  if (cmd === "tabs") {
    out((await pages()).map((t) => ({ title: t.title, url: t.url, id: t.id })));
    return;
  }

  // 需要编辑器页签的命令
  const editorCmds = ["status", "title", "paste", "text", "write", "clear", "focus-end", "click", "key", "insert", "format", "orig", "finish", "save"];
  let cdp = null;
  let edPage = null;
  if (editorCmds.includes(cmd)) {
    edPage = await pick(TAB, "编辑器页签");
    cdp = await openCdp(edPage.webSocketDebuggerUrl);
  }

  try {
    switch (cmd) {
      case "open": {
        const list = await pick(LIST, "草稿箱列表页");
        const lcdp = await openCdp(list.webSocketDebuggerUrl);
        const before = new Set((await pages()).map((t) => t.id));
        const MENU = `(()=>{const v=e=>{const r=e.getBoundingClientRect();return r.width>1&&r.height>1};
          return [...document.querySelectorAll("span.weui-desktop-dropdown__list-ele__text")].filter(v)
            .filter(e=>(e.textContent||"").trim()==="文章").length;})()`;
        let editor = null;
        let btn = null;
        let item = null;
        // 这条链是"点按钮 → 等下拉 → 点菜单项 → 等新页签",任何一步都可能赶上还没渲染完:
        // 所以每一步都轮询到位,整条链失败就重来一次(别在没等到菜单时重复点「新的创作」)。
        for (let attempt = 0; attempt < 2 && !editor; attempt++) {
          btn = await clickEl(lcdp, { selector: "button,a,div,span,[role=button]", text: "新的创作" });
          if (!btn) die("点不到「新的创作」按钮");
          const menu = await waitFor(lcdp, MENU, (n) => n > 0, 20, 300);
          if (!menu) continue; // 下拉没出来,重来
          item =
            (await clickEl(lcdp, {
              selector: "span.weui-desktop-dropdown__list-ele__text",
              text: "文章",
              wrap: "li,.weui-desktop-dropdown__list-ele",
            })) ||
            (await clickEl(lcdp, { selector: "li,div,a,span", text: "文章", wrap: "li" }));
          for (let i = 0; i < 25 && !editor; i++) {
            await sleep(600);
            editor = (await pages()).find((t) => t.url.includes(EDITOR_HINT) && !before.has(t.id));
          }
        }
        if (!editor) {
          lcdp.close();
          die("点了「新的创作 → 文章」但没等到编辑器页签(已重试一次)。先 `tabs` + 截图看当前状态,别连点。");
        }
        try {
          mkdirSync(CACHE, { recursive: true });
          writeFileSync(LAST_EDITOR, JSON.stringify({ id: editor.id, url: editor.url }));
        } catch {}
        lcdp.close();
        out({ created: btn, menu: item, editor: { id: editor.id, url: editor.url } });
        break;
      }

      case "status":
        out(await cdp.eval(STATE));
        break;

      case "title": {
        const text = rest[0];
        if (!text) die("用法: title <文本>");
        const spot = await clickEl(cdp, { selector: TITLE_SEL });
        if (!spot) die(`点不到标题编辑区(${TITLE_SEL})`);
        await cdp.key("meta+a");
        await cdp.key("delete");
        await cdp.insertText(text);
        await sleep(600);
        out({ typed: text, ...(await cdp.eval(STATE)) });
        break;
      }

      case "paste":
      case "text": {
        const val = cmd === "text" ? rest.join(" ") : rest[0];
        if (!val) die(`用法: ${cmd} <${cmd === "text" ? "纯文本" : "file.html|file.png"}>`);
        if (cmd === "text") setClipHtml(`<p>${val}</p>`);
        else clipFor(resolve(val));
        const focus = await focusBody(cdp);
        const caret = await cdp.eval(CARET);
        await cdp.paste(Number(flags.wait || (/\.png$/i.test(val) ? 5000 : 2000)));
        out({ focused: focus, caret, ...(await cdp.eval(STATE)) });
        break;
      }

      case "write": {
        const planPath = resolve(rest[0] || die("用法: write <plan.json>"));
        const plan = JSON.parse(readFileSync(planPath, "utf8"));
        const base = dirname(planPath);
        const waits = { html: 2000, png: 5000, ...(plan.waits || {}) };
        const log = [];
        const stepHtml = (v) => (existsSync(resolve(base, v)) ? setClipHtmlFile(resolve(base, v)) : setClipHtml(v));

        if (plan.title) {
          const spot = await clickEl(cdp, { selector: TITLE_SEL });
          if (!spot) die(`点不到标题编辑区(${TITLE_SEL})`);
          await cdp.key("meta+a");
          await cdp.key("delete");
          await cdp.insertText(plan.title);
          log.push({ title: plan.title });
          await sleep(500);
        }
        if (plan.clear) {
          if (plan.clear !== true && plan.clear !== "yes") die("clear 会清空正文,写 plan 时用 \"clear\": true");
          await focusBody(cdp);
          await cdp.key("meta+a");
          await cdp.key("meta+a");
          await cdp.key("delete");
          log.push({ clear: true, ...(await cdp.eval(STATE)) });
          await sleep(400);
        }

        for (const [i, step] of plan.steps.entries()) {
          const kind = Object.keys(step).find((k) => KNOWN_STEPS.has(k));
          if (!kind) die(`第 ${i} 步无法识别: ${JSON.stringify(step)}`);
          if (kind === "html" || kind === "png") {
            const file = typeof step[kind] === "string" && existsSync(resolve(base, step[kind])) ? resolve(base, step[kind]) : null;
            const clip = kind === "png" ? setClipPng(file || die(`第 ${i} 步图片不存在`)) : stepHtml(String(step[kind]));
            const focus = await focusBody(cdp);
            const caret = await cdp.eval(CARET);
            await cdp.paste(Number(step.wait || waits[kind]));
            log.push({ i, kind, focus, caret, clip, ...(await cdp.eval(STATE)) });
          } else if (kind === "text") {
            setClipHtml(`<p>${step.text}</p>`);
            const focus = await focusBody(cdp);
            await cdp.paste(Number(step.wait || waits.html));
            log.push({ i, kind, focus, ...(await cdp.eval(STATE)) });
          } else if (kind === "key") {
            for (const k of [].concat(step.key)) await cdp.key(k);
            log.push({ i, kind, key: step.key });
          } else if (kind === "wait") {
            await sleep(Number(step.wait));
            log.push({ i, kind, ms: step.wait });
          } else if (kind === "click") {
            const spec = typeof step.click === "string" ? { text: step.click } : step.click;
            const where = spec.where || "start";
            const spot = await cdp.eval(`(()=>{
              const body = document.querySelector(${j(BODY_SEL)});
              const blocks = [...body.children].filter(el=>(el.textContent||"").trim()||el.querySelector("img"));
              const hit = blocks.filter(el=>(el.textContent||"").includes(${j(spec.text)}))
                .sort((a,b)=>a.textContent.length-b.textContent.length)[0];
              if (!hit) return null;
              hit.scrollIntoView({block:"center"});
              const r = hit.getBoundingClientRect();
              return { x: Math.round(${where === "center" ? "r.left+r.width/2" : where === "end" ? "r.right-8" : "r.left+3"}),
                       y: Math.round(${where === "end" ? "r.bottom-8" : "r.top+9"}) };
            })()`);
            if (!spot) die(`第 ${i} 步找不到含「${spec.text}」的正文块`);
            await cdp.click(spot.x, spot.y);
            await sleep(400);
            log.push({ i, kind, spot, caret: await cdp.eval(CARET) });
          } else if (kind === "focusEnd") {
            log.push({ i, kind, ...(await focusEnd(cdp)) });
          }
        }
        out({ steps: log.length, log });
        break;
      }

      case "clear": {
        if (!flags.yes) die("clear 会清空整篇正文。确认后重跑: clear --yes");
        await focusBody(cdp);
        await cdp.key("meta+a");
        await cdp.key("meta+a");
        await cdp.key("delete");
        await sleep(800);
        out({ cleared: true, ...(await cdp.eval(STATE)) });
        break;
      }

      case "focus-end":
        out(await focusEnd(cdp));
        break;

      case "click": {
        const text = rest[0];
        if (!text) die("用法: click <文本> [start|end|center]");
        const where = rest[1] || "start";
        const spot = await cdp.eval(`(()=>{
          const body = document.querySelector(${j(BODY_SEL)});
          const blocks = [...body.children].filter(el=>(el.textContent||"").trim()||el.querySelector("img"));
          const hit = blocks.filter(el=>(el.textContent||"").includes(${j(text)}))
            .sort((a,b)=>a.textContent.length-b.textContent.length)[0];
          if (!hit) return null;
          hit.scrollIntoView({block:"center"});
          const r = hit.getBoundingClientRect();
          return { x: Math.round(${where === "center" ? "r.left+r.width/2" : where === "end" ? "r.right-8" : "r.left+3"}),
                   y: Math.round(${where === "end" ? "r.bottom-8" : "r.top+9"}), text:(hit.textContent||"").slice(0,30) };
        })()`);
        if (!spot) die(`找不到含「${text}」的正文块`);
        await cdp.click(spot.x, spot.y);
        await sleep(400);
        out({ spot, caret: await cdp.eval(CARET) });
        break;
      }

      case "key":
        for (const spec of rest) await cdp.key(spec);
        out({ keys: rest });
        break;

      case "insert": {
        const text = rest.join(" ");
        await focusBody(cdp);
        await cdp.insertText(text);
        out({ inserted: text, ...(await cdp.eval(STATE)) });
        break;
      }

      case "format": {
        if (!flags.force && (await cdp.eval(STATE)).layouted) {
          out({ skipped: "正文已是排版后的结构(data-layout-id);要重排加 --force", ...(await cdp.eval(STATE)) });
          break;
        }
        const r = await runFormat(cdp, edPage.id);
        cdp = await adoptTab(cdp, r.newTab.id); // 排版之后都在新页签上继续
        out({ ...r, workingTab: r.newTab.id, ...(await cdp.eval(STATE)) });
        break;
      }

      case "orig": {
        const name = rest[0] || flags.author || DEFAULT_AUTHOR;
        if (!flags.force && (await cdp.eval(STATE)).original !== "未声明") {
          out({ skipped: "这篇已经声明过原创,不重复声明(要改作者就重新点开原创弹窗)", ...(await cdp.eval(STATE)) });
          break;
        }
        out(await runOrig(cdp, name));
        break;
      }

      case "finish": {
        const name = rest[0] || flags.author || DEFAULT_AUTHOR;
        const log = {};
        if (!flags["no-format"]) {
          if ((await cdp.eval(STATE)).layouted) log.format = { skipped: "已经排过版" };
          else {
            const r = await runFormat(cdp, edPage.id);
            cdp = await adoptTab(cdp, r.newTab.id); // 排版之后都在新页签上继续
            log.format = r;
          }
        }
        if (!flags["no-orig"]) log.orig = (await cdp.eval(STATE)).original !== "未声明"
          ? { skipped: "已经声明过原创" }
          : await runOrig(cdp, name);
        const spot = await clickEl(cdp, { selector: "button,a,div,span,[role=button]", text: "保存为草稿" });
        if (!spot) die("前面的步骤做完了,但点不到「保存为草稿」按钮");
        await sleep(2500);
        log.save = { clicked: spot, ...(await cdp.eval(STATE)) };
        const ok = !!(log.save.layouted && log.save.original && log.save.original.includes(name));
        out({ ok, log });
        if (!ok) {
          console.error(
            `警告:草稿已存,但自检没过(排版=${log.save.layouted}, 原创=${log.save.original})。截图 + status 复核。`
          );
        }
        break;
      }

      case "save": {
        const spot = await clickEl(cdp, { selector: "button,a,div,span,[role=button]", text: "保存为草稿" });
        if (!spot) die("点不到「保存为草稿」按钮");
        await sleep(2500);
        out({ clicked: spot, ...(await cdp.eval(STATE)) });
        break;
      }

      case "drafts": {
        const list = await pick(LIST, "草稿箱列表页");
        const lcdp = await openCdp(list.webSocketDebuggerUrl);
        await lcdp.eval("location.reload(), 1");
        await sleep(4500);
        const r = await lcdp.eval(`(()=>{
          // 卡片 hover 时会多出「发表」这类按钮文本,按停用词剔掉,免得被当成标题
          const SKIP = new Set(["发表","删除","编辑","置顶","新的创作","文章模板"]);
          const L = document.body.innerText.split("\\n").map(s=>s.trim()).filter(s=>s && !SKIP.has(s));
          const i = L.indexOf("新的创作");
          const after = i >= 0 ? L.slice(i+1) : L;
          const items = [];
          for (let k = 0; k < after.length; k++) {
            if (k + 1 < after.length && /^更新于/.test(after[k+1])) { items.push({ title: after[k], time: after[k+1] }); k++; }
            else if (/^已加载全部内容$/.test(after[k])) break;
          }
          return { count: ((document.body.innerText.match(/文章\\s*\\d+/)||[])[0]||null), items: items.slice(0,10) };
        })()`);
        lcdp.close();
        out(r);
        break;
      }

      default:
        die(`未知命令: ${cmd}(用 help 看用法)`);
    }
  } finally {
    if (cdp) cdp.close();
  }
  process.exit(0);
}

/** 光标落到正文末尾:图片块后没有可落光标的文本块,需要点它下面的空白 */
/** 「默认样式」= 排版页上样式列表的第一个(layoutstyle_item_standard) */
const STYLE_SPOT = `(()=>{
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 1 && r.height > 1; };
  const items = [...document.querySelectorAll(".layoutstyle_item")].filter(vis);
  if (!items.length) return null;
  const e = items[0];
  e.scrollIntoView({block:"center"});
  const r = e.getBoundingClientRect();
  return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2), cls: String(e.className) };
})()`;

/**
 * 一键排版:编辑器右下角「一键排版」→ 新开排版页签 → 用默认样式 → 「使用此排版」。
 *
 * **排版之后一切都在新页签上继续。** 排版页签自己会跳成编辑器页签,它带着排版结果从库里
 * 重新加载;旧页签是排版前的内存状态,未必跟着更新(实测同一草稿的两个编辑器页签各是各的,
 * 在旧页签上继续做,轻则看不到排版,重则把旧内容存回草稿覆盖掉排版)。
 *
 * 所以这里返回 newTab,由调用方把工作连接切过去;页签缓存也一并指过去。
 */
async function runFormat(cdp, oldTabId) {
  const before = await cdp.eval(STATE);
  const beforeText = await cdp.eval(BODY_TEXT);
  const known = new Set((await pages()).map((t) => t.id));
  const btn = await clickEl(cdp, { selector: ".ailayout-btn_wrp" });
  if (!btn) die("点不到「一键排版」按钮(编辑器右下角,正文底部工具栏里)");
  let tool = null;
  for (let i = 0; i < 30 && !tool; i++) {
    await sleep(600);
    tool = (await pages()).find((t) => t.url.includes(LAYOUT_HINT) && !known.has(t.id));
  }
  if (!tool) die("点了「一键排版」但没等到排版页签(URL 含 articlestruct)。截图看一眼再决定重试,别连点。");

  let styleSelected = null;
  const tcdp = await openCdp(tool.webSocketDebuggerUrl);
  try {
    const ready = await waitFor(tcdp, LAYOUT_PROBE, (p) => p.ready, 40, 600);
    if (!ready || !ready.ready) die("排版页签里没等到「使用此排版」按钮");
    styleSelected = ready.styleSelected;
    // 显式点第一个样式(默认就是它),免得上次的选择被记住
    await clickSpot(tcdp, STYLE_SPOT);
    await sleep(2500); // 等预览按新样式重排
    if (!(await clickEl(tcdp, { selector: ".article_layout-save" }))) die("点不到「使用此排版」");
  } finally {
    tcdp.close();
  }

  let back = null;
  for (let i = 0; i < 40 && !back; i++) {
    await sleep(600);
    back = (await pages()).find((t) => t.id === tool.id && t.url.includes(EDITOR_HINT));
  }
  if (!back) die("点了「使用此排版」,但那个页签没跳回编辑器。截图看一眼(它可能还停在排版页)。");
  await sleep(2000);

  try {
    mkdirSync(CACHE, { recursive: true });
    writeFileSync(LAST_EDITOR, JSON.stringify({ id: back.id, url: back.url }));
  } catch {}

  // 之后的命令都走新页签;先确认它真的带着排版
  const ndp = await openCdp(back.webSocketDebuggerUrl);
  try {
    const state = await waitFor(ndp, STATE, (s) => s.layouted, 30, 700);
    if (!state || !state.layouted) {
      die(`排版回的新页签(${back.id})里没看到排版结构(data-layout-id)。别在旧页签上接着做,截图核对后再重试。`);
    }
    const bodyDiff = diffText(beforeText, await ndp.eval(BODY_TEXT));
    return {
      format: "使用此排版",
      styleSelected,
      layouted: state.layouted,
      contentBlocks: state.contentBlocks,
      titleBefore: before.title,
      titleAfter: state.title,
      titleChanged: before.title !== state.title,
      charsBefore: bodyDiff.charsBefore,
      charsAfter: bodyDiff.charsAfter,
      diff: bodyDiff.charsBefore === bodyDiff.charsAfter ? "正文长度没变" : "正文有出入,见 dropped",
      dropped: bodyDiff.dropped.slice(0, 5),
      newTab: { id: back.id, url: back.url },
      oldTab: { id: oldTabId, note: "旧页签留着了,别在它上面点保存" },
    };
  } finally {
    ndp.close();
  }
}

/** 把工作连接切到另一个页签(关掉旧的,返回新的) */
async function adoptTab(cdp, id) {
  const p = (await pages()).find((t) => t.id === id);
  if (!p) die(`切页签失败:找不到 ${id}`);
  cdp.close();
  return openCdp(p.webSocketDebuggerUrl);
}

/** 在可见的原创弹窗里找一个元素并点击 */
const origDialogSpot = (findJs) => `(()=>{
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const d = [...document.querySelectorAll(".weui-desktop-dialog")].filter(vis)
    .find(e => (e.innerText||"").includes("声明类型"));
  if (!d) return null;
  const e = (${findJs})(d);
  if (!e) return null;
  e.scrollIntoView({block:"center"});
  const r = e.getBoundingClientRect();
  return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2), text: (e.innerText||"").trim().slice(0,20) };
})()`;

/** 声明原创:开弹窗 → 文字原创 → 作者(逐字真实按键) → 勾协议 → 确定 → 回读验收 */
async function runOrig(cdp, name) {
  let row = null;
  let dlg = null;
  // 页面刚刷新/刚初始化完时点了没反应是常事,点两次不亏(弹窗没出来之前重复点是幂等的)
  for (let attempt = 0; attempt < 2 && !(dlg && dlg.found); attempt++) {
    row = await clickEl(cdp, { selector: "#js_original .js_edit_ori" });
    if (!row) die("点不到「原创」那一行(正文为空时底部设置区可能不出现)");
    dlg = await waitFor(cdp, ORIG_PROBE, (p) => p && p.found && p.hasOk, 12, 400);
    if (!(dlg && dlg.found)) await sleep(800); // 页面可能还没初始化完,缓一下再点
  }
  if (!dlg || !dlg.found) {
    die("点了「原创」但没等到声明弹窗(已试两次)。换个编辑器页签或重载页面再试,别连点。");
  }

  if (dlg.type !== "0") {
    await clickSpot(
      cdp,
      origDialogSpot(`d => [...d.querySelectorAll('input.js_original_type_radio')].filter(vis).find(i => i.value === "0")`)
    );
    await sleep(400);
  }
  if (!dlg.nameAt) die("原创弹窗里找不到「作者」输入框");
  await cdp.click(dlg.nameAt.x, dlg.nameAt.y);
  await sleep(250);
  await cdp.key("meta+a");
  await cdp.key("delete");
  await cdp.typeText(name); // 必须真实按键:insertText 只改 value,Vue 收不到 input
  const typed = await cdp.eval(ORIG_PROBE);
  if (!typed || typed.name !== name) {
    die(`「作者」里现在是「${typed && typed.name}」,不是「${name}」。截图看一眼(可能是输入框没聚焦)。`);
  }
  if (typed.agree === false) {
    const cb = await clickSpot(cdp, origDialogSpot(`d => d.querySelector(".weui-desktop-form__check-label")`));
    if (!cb) die("点不到《微信公众平台原创声明及相关功能使用协议》的勾选框");
    await sleep(400);
  }
  const ok = await clickSpot(
    cdp,
    origDialogSpot(`d => [...d.querySelectorAll("button")].filter(vis).find(b => (b.innerText||"").trim() === "确定")`)
  );
  if (!ok) die("点不到原创弹窗里的「确定」");
  await sleep(3000);

  const state = await cdp.eval(STATE);
  if (state.original === "未声明" || !String(state.original || "").includes(name)) {
    const leftover = await cdp.eval(ORIG_PROBE);
    die(
      `声明原创没成功。弹窗${leftover && leftover.found ? `里还留着:${leftover.text}` : "已关闭"},正文底部「原创」那行是:${state.original}`
    );
  }
  return { clicked: row, author: name, agreeWasChecked: typed.agree, original: state.original };
}

async function focusEnd(cdp) {
  const last = await cdp.eval(`(()=>{
    const body = document.querySelector(${j(BODY_SEL)});
    if (!body) return null;
    const blocks = [...body.children].filter(el=>(el.textContent||"").trim()||el.querySelector("img"));
    const b = blocks[blocks.length-1];
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x:Math.round(r.left), right:Math.round(r.right), top:Math.round(r.top), bottom:Math.round(r.bottom),
             h:Math.round(r.height), img: !!b.querySelector("img") };
  })()`);
  if (!last) return { ready: false, reason: "正文里还没有内容块,先粘一段正文" };
  const spots = last.img
    ? [[last.x + 40, last.bottom + 14], [last.x + 40, last.bottom + 26], [last.right - 10, last.bottom + 14]]
    : [[last.right - 10, last.bottom - 8], [last.right - 10, last.bottom - 14], [last.right - 30, last.bottom - 4]];
  let caret = null;
  for (const [x, y] of spots) {
    await cdp.click(x, y);
    await sleep(400);
    caret = await cdp.eval(CARET);
    if (caret && caret.inBody) break;
  }
  return { ready: !!(caret && caret.inBody), lastBlock: last, caret };
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(2);
});
