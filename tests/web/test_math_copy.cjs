/* 用法：node --test tests/web/test_math_copy.cjs
   验证公式渲染和真实事件处理器协作，确保复制源码及剪贴板失败反馈正确。 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function reader(block, clipboardError) {
  let html = "";
  const listeners = new Map(), copied = [], toasts = [];
  const host = { dataset: { id: block.id }, classList: { contains: () => false }, querySelector: () => null, replaceWith() {} };
  const PR = {
    state: { reader: { edits: {} }, paper: { blocks: [block] } },
    on() {}, emit() {}, throttle: fn => fn, t: text => text,
    esc: value => String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])),
    icon: () => '<svg aria-hidden="true"></svg>',
    toast: text => toasts.push(text),
  };
  const context = {
    window: { PR, addEventListener() {} }, URL,
    katex: require("../../easyread/web/vendor/katex/katex.min.js"),
    document: {
      getElementById: () => host,
      createElement: () => ({ set innerHTML(value) { html = value; }, firstChild: {} }),
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
    },
    navigator: { clipboard: { async writeText(value) {
      if (clipboardError) throw clipboardError;
      copied.push(value);
    } } },
  };
  for (const script of ["common/markup.js", "reader/render.js", "reader/actions.js"]) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../easyread/web/js", script), "utf8"), context);
  }
  PR.blockById[block.id] = block;
  PR.renderBlock(block.id);
  const button = {
    dataset: { t: "copy-math" },
    closest: selector => selector === "#paper" ? {} : selector === ".blk" ? host : null,
  };
  return {
    PR, context, copied, toasts, get html() { return html; },
    async click() {
      // 模拟点击按钮内的 SVG，验证事件委托仍能找到按钮且不会打开段落工具条。
      const target = { closest: selector => {
        if (selector === "#paper .blk") return host;
        if (selector === "[data-t]" || selector === "a, button, textarea, mark, .editor-wrap, input") return button;
        return null;
      } };
      for (const listener of listeners.get("click")) await listener({ target });
    },
  };
}

test("有序号公式在右侧显示复制按钮并原样复制多行 LaTeX", async () => {
  const tex = String.raw`\begin{aligned}
x &= \frac{a_1}{b^2} \\
y &= \alpha + \text{测试}
\end{aligned}`;
  const r = reader({ id: "eq1", type: "math", tag: '1"<', tex });
  assert.match(r.html, /class="katex-display"/);
  assert.match(r.html, /class="math-tools"><div class="math-tag">\(1&quot;&lt;\)<\/div><button/);
  assert.match(r.html, /type="button"[^>]*data-t="copy-math"[^>]*aria-label="复制公式（LaTeX）"/);
  await r.click();
  assert.deepEqual(r.copied, [tex]);
  assert.deepEqual(r.toasts, ["已复制公式 LaTeX"]);
  assert.equal(r.PR.currentBlock(), null);
});

test("无序号公式也能复制，重渲染后读取最新源码", async () => {
  const r = reader({ id: "eq1", type: "math", tex: "x = 1" });
  assert.doesNotMatch(r.html, /class="math-tag"/);
  assert.match(r.html, /data-t="copy-math"/);
  r.PR.blockById.eq1 = { id: "eq1", type: "math", tex: String.raw`x = \sqrt{2}` };
  r.PR.renderBlock("eq1");
  await r.click();
  assert.deepEqual(r.copied, [String.raw`x = \sqrt{2}`]);
});

test("空公式不显示复制按钮，也不写入剪贴板", async () => {
  const r = reader({ id: "eq1", type: "math", tex: "  " });
  assert.doesNotMatch(r.html, /data-t="copy-math"/);
  await r.click();
  assert.deepEqual(r.copied, []);
  assert.deepEqual(r.toasts, []);
});

test("剪贴板拒绝写入时提示失败", async () => {
  const r = reader({ id: "eq1", type: "math", tex: "x = 1" }, new Error("denied"));
  await r.click();
  assert.deepEqual(r.copied, []);
  assert.deepEqual(r.toasts, ["复制公式失败，请重试"]);
});

test("剪贴板 API 不可用时仍能反馈失败", async () => {
  const r = reader({ id: "eq1", type: "math", tex: "x = 1" });
  delete r.context.navigator.clipboard;
  await r.click();
  assert.deepEqual(r.toasts, ["复制公式失败，请重试"]);
});
