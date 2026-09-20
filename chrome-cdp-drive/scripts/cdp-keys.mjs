// 对"当前焦点"发真实按键 / 插入文本 —— 不做聚焦点击,所以光标不会乱跑。
//
// 为什么需要单独一个脚本:
//   cdp-type.mjs 的定位逻辑是"scrollIntoView + focus() + 在元素中心打一次真实鼠标点击",
//   那一下点击(为了激活 contenteditable)会把光标挪到正文中间 —— 于是在多行富文本里
//   输入的文字会插到句子里,而不是末尾。富文本编辑器(ProseMirror / tiptap / 抖音快手小红书的
//   发布编辑器)全靠光标位置决定插入点,必须先自己把选区摆好再输入。
//
// 用法(env 传参,输出的 JSON 便于确认):
//   CDP_WS=ws://... [CDP_FIND='<JS 返回元素>']        # 可选:先把焦点给某个元素(只 focus,不点击)
//                [CDP_SEL_END='<CSS 选择器>']        # 把选区收拢到该元素内容末尾
//                [CDP_SEL_ALL='<CSS 选择器>']        # 选中该元素全部内容(配合 CDP_KEYS=Backspace 清空)
//                [CDP_KEYS='meta+a,Backspace']       # 真实按键,逗号分隔,支持 meta/ctrl/alt/shift 组合
//                [CDP_TEXT='要插入的文字']            # Input.insertText(一次性插入,快)
//                [CDP_TYPE='#任务管理']               # 逐字符真实按键(联想/话题面板只认这种)
//                node cdp-keys.mjs
//
// 执行顺序固定为:FIND(聚焦) → SEL_ALL / SEL_END → KEYS → TEXT → TYPE
//   - 纯文本输入、整体替换:用 TEXT(配合 SEL_ALL + KEYS='Backspace')
//   - 触发联想面板(打 # 或 @ 起头):必须用 TYPE
//
// 输出:before/after 的 {tag,cls,editable,text,caret} —— caret 是当前选区的 startOffset,
// 富文本里判断"光标到底在哪"靠它。

const wsUrl = process.env.CDP_WS;
if (!wsUrl) {
  console.error("需要 CDP_WS");
  process.exit(1);
}
const findExpr = process.env.CDP_FIND || "";
const selAll = process.env.CDP_SEL_ALL || "";
const selEnd = process.env.CDP_SEL_END || "";
const text = process.env.CDP_TEXT || "";
const typeText = process.env.CDP_TYPE || "";
const keys = (process.env.CDP_KEYS || "").split(",").map((s) => s.trim()).filter(Boolean);

const KEYMAP = {
  a: { key: "a", code: "KeyA", vk: 65 }, c: { key: "c", code: "KeyC", vk: 67 },
  v: { key: "v", code: "KeyV", vk: 86 }, x: { key: "x", code: "KeyX", vk: 88 },
  z: { key: "z", code: "KeyZ", vk: 90 },
  Backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  Delete: { key: "Delete", code: "Delete", vk: 46 },
  Enter: { key: "Enter", code: "Enter", vk: 13 },
  Tab: { key: "Tab", code: "Tab", vk: 9 },
  Escape: { key: "Escape", code: "Escape", vk: 27 },
  End: { key: "End", code: "End", vk: 35 },
  Home: { key: "Home", code: "Home", vk: 36 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
};

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
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  }
};
ws.onerror = (e) => {
  console.error("WS error:", e.message || e);
  process.exit(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const READ_FOCUS = `(() => {
  const e = document.activeElement;
  if (!e) return null;
  const sel = getSelection();
  const anchor = sel && sel.anchorNode
    ? (sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode)
    : null;
  return {
    tag: e.tagName,
    cls: (typeof e.className === "string" ? e.className : "").slice(0, 60),
    editable: e.isContentEditable,
    text: (e.isContentEditable ? e.innerText : (e.value || "")).slice(-300),
    len: (e.isContentEditable ? e.innerText : (e.value || "")).length,
    caret: sel ? sel.anchorOffset : null,
    anchorInFocused: anchor ? (e === anchor || e.contains(anchor)) : null,
  };
})()`;

const evalIn = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true });
  if (r.exceptionDetails) throw new Error("EVAL: " + JSON.stringify(r.exceptionDetails.exception));
  return r.result.value;
};

// 把选区摆到目标元素的末尾(不 focus —— focus() 本身会把光标重置到开头)
const selectIn = (selector, all) => {
  const expr = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return "no-el";
    if (document.activeElement !== el) el.focus();
    const rng = document.createRange();
    rng.selectNodeContents(el);
    ${all ? "" : "rng.collapse(false);"}
    const s = getSelection(); s.removeAllRanges(); s.addRange(rng);
    return "ok:" + s.getRangeAt(0).startOffset;
  })()`;
  return expr;
};

ws.onopen = async () => {
  const out = {};
  try {
    await send("Runtime.enable");
    await sleep(200);
    out.before = await evalIn(READ_FOCUS);

    if (findExpr) {
      const r1 = await send("Runtime.evaluate", { expression: findExpr, returnByValue: false });
      const objectId = r1.result && r1.result.objectId;
      if (!objectId) {
        console.log(JSON.stringify({ error: "CDP_FIND 未命中" }, null, 2));
        ws.close();
        process.exit(0);
      }
      await send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function(){ if (document.activeElement !== this) this.focus(); return 1; }",
        returnByValue: true,
      });
      await sleep(200);
    }

    if (selAll) {
      out.selAll = await evalIn(selectIn(selAll, true));
      await sleep(150);
    }
    if (selEnd) {
      out.selEnd = await evalIn(selectIn(selEnd, false));
      await sleep(150);
    }

    for (const k of keys) {
      const parts = k.split("+");
      const name = parts[parts.length - 1];
      const mods = parts.slice(0, -1).map((p) => p.toLowerCase());
      let modifierBits = 0;
      if (mods.includes("meta") || mods.includes("cmd")) modifierBits |= 4;
      if (mods.includes("shift")) modifierBits |= 8;
      if (mods.includes("ctrl")) modifierBits |= 2;
      if (mods.includes("alt")) modifierBits |= 1;
      const kk = KEYMAP[name] || { key: name, code: name, vk: 0 };
      await send("Input.dispatchKeyEvent", {
        type: "rawKeyDown", modifiers: modifierBits, key: kk.key, code: kk.code,
        windowsVirtualKeyCode: kk.vk, nativeVirtualKeyCode: kk.vk,
      });
      await send("Input.dispatchKeyEvent", {
        type: "keyUp", modifiers: modifierBits, key: kk.key, code: kk.code,
        windowsVirtualKeyCode: kk.vk, nativeVirtualKeyCode: kk.vk,
      });
      await sleep(150);
    }

    if (text) {
      await send("Input.insertText", { text });
      await sleep(600);
    }

    if (typeText) {
      for (const ch of typeText) {
        if (ch === "\n") {
          await send("Input.dispatchKeyEvent", {
            type: "keyDown", key: "Enter", code: "Enter",
            windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r",
          });
          await send("Input.dispatchKeyEvent", {
            type: "keyUp", key: "Enter", code: "Enter",
            windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
          });
        } else {
          await send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch });
          await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
        }
        await sleep(40);
      }
      await sleep(500);
    }

    out.after = await evalIn(READ_FOCUS);
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
}, 30000);
