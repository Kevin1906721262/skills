// 小红书:搜索帖子 / 打开帖子并发表评论(通过 CDP 驱动本机已登录的 Chrome)。
//
// 用法:
//   node xhs.mjs search "<关键词>" [--limit 30] [--scroll 3]
//   node xhs.mjs comment <noteId> "<评论内容>" [--keyword "<关键词>"]
//
// 环境变量:CDP_PORT(默认 9222)
// 前置:Chrome 已用 --remote-debugging-port 启动,且已登录小红书(见 chrome-cdp-drive skill)。
//
// 输出:stdout 打印 JSON。search 返回帖子数组;comment 返回 {ok, noteId, author, title, text, ...}。

const PORT = process.env.CDP_PORT || "9222";
const BASE = `http://127.0.0.1:${PORT}`;
const XHS_HOST = "xiaohongshu.com";

// ---------- HTTP(Chrome DevTools HTTP API) ----------

async function httpJson(path) {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
  return res.json();
}

async function ensureChrome() {
  try {
    await httpJson("/json/version");
  } catch {
    throw new Error(
      `连不上 Chrome 调试端口 ${PORT}。请先启动自动化 Chrome:\n` +
        `  nohup ~/.chrome-automation-launch.sh &   # 然后等 2~3s`
    );
  }
}

// 取一个已打开的小红书页签;没有就新开一个(新开用 PUT,/json/new 只接受 PUT)。
async function pickTab() {
  const tabs = await httpJson("/json");
  const hit = tabs.find((t) => t.type === "page" && (t.url || "").includes(XHS_HOST));
  if (hit) return hit.webSocketDebuggerUrl;
  const res = await fetch(`${BASE}/json/new?${encodeURIComponent(`https://www.${XHS_HOST}/explore`)}`, {
    method: "PUT",
  });
  if (!res.ok) throw new Error(`新开页签失败:HTTP ${res.status}`);
  const tab = await res.json();
  return tab.webSocketDebuggerUrl;
}

// ---------- CDP ----------

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      }
    };
    ws.onerror = (e) => reject(new Error("WS error: " + (e.message || e)));
    ws.onopen = () =>
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const msgId = ++id;
            pending.set(msgId, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id: msgId, method, params }));
          });
        },
        close: () => ws.close(),
      });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(page, expression, awaitPromise = false) {
  const r = await page.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) {
    throw new Error("页面执行异常: " + JSON.stringify(r.exceptionDetails).slice(0, 300));
  }
  return r.result.value;
}

// 轮询直到表达式返回真;超时返回 null。
async function waitFor(page, expression, timeoutMs = 20000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let v = null;
    try {
      v = await evaluate(page, expression);
    } catch {
      v = null;
    }
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(intervalMs);
  }
}

async function navigate(page, url) {
  await page.send("Page.enable");
  await page.send("Page.navigate", { url });
  await waitFor(page, `document.readyState === "complete"`, 25000, 300);
}

// 点击元素:先做命中测试,命中就发 trusted 鼠标事件;被浮层挡住就退回 el.click()。
// (小红书帖子详情底部有 .note-detail-mask 浮层,坐标点击会打到浮层上)
async function clickElement(page, findExpr, { force = false } = {}) {
  const r1 = await page.send("Runtime.evaluate", { expression: findExpr, returnByValue: false });
  const objId = r1.result && r1.result.objectId;
  if (!objId) return null;
  const r2 = await page.send("Runtime.callFunctionOn", {
    objectId: objId,
    functionDeclaration: `function(){
      this.scrollIntoView({block:'center',inline:'center'});
      const r=this.getBoundingClientRect();
      const x=Math.round(r.left+r.width/2), y=Math.round(r.top+r.height/2);
      const el=document.elementFromPoint(x,y);
      // 只认「最上层元素就是自己或自己的子元素」;被祖先浮层盖住不算命中
      // (小红书详情页的 .note-detail-mask 是按钮的祖先,曾误判为命中)
      const hit = !!el && (el===this || this.contains(el));
      return {x, y, w:Math.round(r.width), h:Math.round(r.height), hit};
    }`,
    returnByValue: true,
  });
  const pos = r2.result.value;
  if (!pos) return null;
  if (force || !pos.hit) {
    await page.send("Runtime.callFunctionOn", {
      objectId: objId,
      functionDeclaration: `function(){ this.click(); }`,
      returnByValue: true,
    });
    return { ...pos, mode: force ? "forced-js-click" : "js-click" };
  }
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pos.x, y: pos.y });
  await page.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1,
  });
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1,
  });
  return { ...pos, mode: "trusted-mouse" };
}

// ---------- 页面脚本片段 ----------

const EXTRACT_RESULTS = `(() => {
  const seen = new Set(); const out = [];
  for (const s of document.querySelectorAll('section.note-item')) {
    const id = s.dataset.noteId || '';
    if (!id || id.includes('#')) continue;          // 广告卡/直播卡没有正常 noteId
    if (seen.has(id)) continue;
    const cv = s.querySelector('a.cover');
    if (!cv) continue;
    const g = (q) => { const e = s.querySelector(q); return e ? e.textContent.trim() : ''; };
    seen.add(id);
    out.push({
      id,
      title: g('a.title'),
      author: g('a.author .name'),
      time: g('a.author .time'),
      likes: g('.like-wrapper .count'),
      href: cv.getAttribute('href') || '',
    });
  }
  return out;
})()`;

const commentStateExpr = (text) => `(() => {
  const input = document.querySelector('p.content-input');
  const btn = document.querySelector('.btn.submit');
  const countEl = document.querySelector('.comments-container .total, .comment-list .total');
  const body = document.body.innerText || '';
  const errWords = ['操作频繁', '过于频繁', '请稍后再试', '验证', '登录后', '评论失败', '发送失败'];
  return {
    hasInput: !!input,
    inputText: input ? (input.innerText || '').trim() : null,
    submitDisabled: !btn || /gray|disabled/.test(btn.className),
    commentCount: countEl ? countEl.textContent.trim() : null,
    toastSuccess: body.includes('评论成功'),
    hasOurText: body.includes(${JSON.stringify(text)}),
    error: errWords.find((w) => body.includes(w)) || null,
    authorOnPage: (() => { const a = document.querySelector('.author-container .name, .author-wrapper .name'); return a ? a.textContent.trim() : null; })(),
  };
})()`;

// 评论数文本形如「共 1 条评论」,取其中的数字做比较。
const countNum = (s) => {
  const m = String(s == null ? "" : s).match(/\d+/);
  return m ? Number(m[0]) : null;
};

// ---------- 命令 ----------

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else { flags[key] = next; i++; }
    } else positional.push(a);
  }
  return { positional, flags };
}

async function doSearch(page, keyword, { limit = 30, scroll = 0 } = {}) {
  const url = `https://www.${XHS_HOST}/search_result?keyword=${encodeURIComponent(keyword)}&source=web_explore_feed`;
  await navigate(page, url);
  const ok = await waitFor(page, `document.querySelectorAll('section.note-item').length > 0`, 20000);
  if (!ok) {
    const body = await evaluate(page, `document.body.innerText.slice(0, 200)`);
    return { ok: false, keyword, url, error: "没等到搜索结果(可能未登录或触发风控)", body };
  }
  for (let i = 0; i < Number(scroll); i++) {
    await evaluate(page, `window.scrollTo(0, document.body.scrollHeight)`);
    await sleep(1200);
  }
  const items = await evaluate(page, EXTRACT_RESULTS);
  return { ok: true, keyword, url, count: items.length, items: items.slice(0, Number(limit)) };
}

async function doComment(page, noteId, text, { keyword, dry = false } = {}) {
  const out = { noteId, text, keyword: keyword || null, dry, author: null, title: null, steps: [] };

  const directUrl = `https://www.${XHS_HOST}/explore/${noteId}`;
  if (keyword) {
    const search = await doSearch(page, keyword, { limit: 200 });
    if (!search.ok) return { ...out, ok: false, error: search.error };
    const card = search.items.find((x) => x.id === noteId);
    if (!card) return { ...out, ok: false, error: `在关键词「${keyword}」结果里没找到笔记 ${noteId}` };
    out.author = card.author;
    out.title = card.title;
    // 搜索结果卡片的 href 自带 xsec_token,直接导航最稳(点封面会因瀑布流重排点偏)
    const target = card.href ? `https://www.${XHS_HOST}${card.href}` : directUrl;
    await navigate(page, target);
    if (!(await waitFor(page, `!!document.querySelector('p.content-input')`, 12000))) {
      // 兜底:回到搜索页,用真实鼠标点封面
      out.steps.push("href-nav-failed-fallback-click");
      await doSearch(page, keyword, { limit: 200 });
      await sleep(1500);
      const pos = await clickElement(
        page,
        `(() => { const s = document.querySelector('section.note-item[data-note-id="${noteId}"]'); return s ? s.querySelector('a.cover') : null; })()`
      );
      if (!pos) return { ...out, ok: false, error: "帖子详情没打开,且点不到封面" };
    } else {
      out.steps.push("opened-by-card-href");
    }
  } else {
    await navigate(page, directUrl);
    out.steps.push("opened-direct-url");
  }

  const ready = await waitFor(page, `!!document.querySelector('p.content-input')`, 25000);
  if (!ready) {
    const body = await evaluate(page, `document.body.innerText.slice(0, 200)`);
    return { ...out, ok: false, error: "没等到评论输入框", body };
  }
  await sleep(800);
  const before = await evaluate(page, commentStateExpr(text));
  out.commentCountBefore = before.commentCount;
  out.authorOnPage = before.authorOnPage;

  // 聚焦 + 真实点击,再插入文本(contenteditable 需要先激活)
  const focusRet = await evaluate(page, `(() => {
    const e = document.querySelector('p.content-input');
    e.scrollIntoView({block:'center',inline:'center'}); e.focus();
    const r = e.getBoundingClientRect();
    return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)};
  })()`);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: focusRet.x, y: focusRet.y });
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: focusRet.x, y: focusRet.y, button: "left", clickCount: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: focusRet.x, y: focusRet.y, button: "left", clickCount: 1 });
  await sleep(500);

  await page.send("Input.insertText", { text });
  await sleep(600);
  let typed = await evaluate(page, `(document.querySelector('p.content-input')||{}).innerText || ''`);
  if (!typed || !typed.trim()) {
    // 兜底:execCommand 插入
    await evaluate(page, `(() => {
      const e = document.querySelector('p.content-input');
      e.focus();
      const sel = window.getSelection(); const r = document.createRange();
      r.selectNodeContents(e); sel.removeAllRanges(); sel.addRange(r);
      document.execCommand('insertText', false, ${JSON.stringify(text)});
      return e.innerText;
    })()`);
    await sleep(500);
    typed = await evaluate(page, `(document.querySelector('p.content-input')||{}).innerText || ''`);
  }
  out.typedText = (typed || "").trim();
  if (!out.typedText) return { ...out, ok: false, error: "文本没输进评论框" };

  const state = await evaluate(page, commentStateExpr(text));
  if (state.submitDisabled) {
    return { ...out, ok: false, error: "发送按钮仍为灰(未激活),可能被风控或未登录" };
  }

  if (dry) {
    // 只验证到"文本已进框、发送按钮可点",不真正发表;清空输入框。
    out.ok = true;
    out.dryRunVerified = { submitEnabled: !state.submitDisabled, typedText: out.typedText };
    await evaluate(page, `(() => {
      const e = document.querySelector('p.content-input');
      e.focus();
      const sel = window.getSelection(); const r = document.createRange();
      r.selectNodeContents(e); sel.removeAllRanges(); sel.addRange(r);
      document.execCommand('delete');
      e.blur();
      return e.innerText;
    })()`);
    out.steps.push("dry-run-cleared-input");
    return out;
  }

  const btnPos = await clickElement(page, `document.querySelector('.btn.submit')`);
  if (!btnPos) return { ...out, ok: false, error: "点不到发送按钮" };
  out.submitClickMode = btnPos.mode;
  out.steps.push("clicked-submit");
  await sleep(2500);

  let after = await evaluate(page, commentStateExpr(text));
  if ((after.inputText || "").trim() && !after.toastSuccess) {
    // 第一次点击可能被浮层吃掉:换一种机制强制再点一次
    out.steps.push("retry-submit");
    await clickElement(page, `document.querySelector('.btn.submit')`, { force: true });
    await sleep(2500);
    after = await evaluate(page, commentStateExpr(text));
  }
  out.commentCountAfter = after.commentCount;
  out.inputClearedAfterSend = !(after.inputText || "").trim();

  const beforeN = countNum(out.commentCountBefore);
  const afterN = countNum(out.commentCountAfter);
  const countUp = beforeN != null && afterN != null && afterN > beforeN;

  out.ok = Boolean(after.toastSuccess || countUp || (out.inputClearedAfterSend && after.hasOurText));
  if (after.error) { out.ok = false; out.error = `页面提示风控/异常:${after.error}`; }
  if (!out.ok && !out.error) out.error = "未确认评论成功(没看到「评论成功」也没看到计数+1),请人工核对";
  return out;
}

// ---------- 入口 ----------

const { positional, flags } = parseArgs(process.argv.slice(2));
const cmd = positional[0];

if (!cmd || !["search", "comment"].includes(cmd)) {
  console.error('用法:\n  node xhs.mjs search "<关键词>" [--limit 30] [--scroll 3]\n  node xhs.mjs comment <noteId> "<评论内容>" [--keyword "<关键词>"]');
  process.exit(1);
}

try {
  await ensureChrome();
  const wsUrl = await pickTab();
  const page = await connect(wsUrl);
  let result;
  if (cmd === "search") {
    if (!positional[1]) throw new Error("缺少关键词");
    result = await doSearch(page, positional[1], { limit: flags.limit || 30, scroll: flags.scroll || 0 });
  } else {
    if (!positional[1] || !positional[2]) throw new Error("用法: comment <noteId> \"<评论内容>\"");
    result = await doComment(page, positional[1], positional[2], { keyword: flags.keyword, dry: flags.dry === true });
  }
  console.log(JSON.stringify(result, null, 2));
  page.close();
  process.exit(result.ok === false ? 2 : 0);
} catch (e) {
  console.error("ERROR:", e.message);
  process.exit(3);
}
