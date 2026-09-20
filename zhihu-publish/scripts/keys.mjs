// 通过 CDP Input 域发送真实键盘事件 / 插入文本(知乎的想法编辑器认真实键盘, 不认 execCommand 删除)。
// 用法:
//   node keys.mjs --ws <ws> --ops '[{"key":"meta+a"},{"key":"Backspace"},{"text":"abc"},{"key":"Enter"}]'
//   --ops 里每一项: {"key":"..."} 或 {"text":"..."}; 可选 {"wait": 毫秒}(该项之后等待, 默认 250)
//   支持 key: meta+a / Backspace / Delete / Enter / Escape / space
// 提示: 删编辑器末尾的字符前, 先用 Range 把光标收拢到末尾(见 SKILL.md 第 3 步), 否则删的是光标处。

const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) opt[argv[i].slice(2)] = argv[++i];
}
const wsUrl = opt.ws || process.env.CDP_WS;
const ops = JSON.parse(opt.ops || process.env.CDP_OPS || "[]");

const KEY = {
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Enter: { key: "Enter", code: "Enter", keyCode: 13 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  space: { key: " ", code: "Space", keyCode: 32 },
};

if (!wsUrl) {
  console.error("需要 --ws(或 CDP_WS)");
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

async function pressKey(spec) {
  if (/^meta\+/.test(spec)) {
    const ch = spec.slice(5);
    const code = "Key" + ch.toUpperCase();
    const vk = ch.toUpperCase().charCodeAt(0);
    await send("Input.dispatchKeyEvent", {
      type: "rawKeyDown", key: ch, code, windowsVirtualKeyCode: vk, modifiers: 4,
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp", key: ch, code, windowsVirtualKeyCode: vk, modifiers: 4,
    });
    return;
  }
  const k = KEY[spec];
  if (!k) throw new Error("不支持的按键: " + spec);
  await send("Input.dispatchKeyEvent", {
    type: "rawKeyDown", key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode,
  });
  if (k.key.length === 1) {
    await send("Input.dispatchKeyEvent", {
      type: "char", text: k.key, key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode,
    });
  }
  await send("Input.dispatchKeyEvent", {
    type: "keyUp", key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode,
  });
}

ws.onopen = async () => {
  try {
    await send("Runtime.enable");
    for (const op of ops) {
      if (op.text != null) {
        await send("Input.insertText", { text: op.text });
      } else if (op.key) {
        await pressKey(op.key);
      }
      await sleep(op.wait ?? 250);
    }
    const r = await send("Runtime.evaluate", {
      expression: `(()=>{const ed=[...document.querySelectorAll("div[contenteditable=true]")]
        .find(e=>e.getBoundingClientRect().width>0);
        return {text: ed ? ed.innerText.replace(/\\u200b/g,"") : null};})()`,
      returnByValue: true,
    });
    console.log(JSON.stringify({ ok: true, text: r.result.value.text }, null, 2));
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
}, 20000);
