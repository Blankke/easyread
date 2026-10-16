/* 用法：node --test tests/desktop/test_chatgpt_answer.cjs。
 * 使用显式时间和最小 DOM 验证回答完整性，无需账号或真实等待。
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createAnswerGate, readAnswer } = require('../../electron/chatgpt-answer.cjs');

const answer = changes => ({ count: 2, revision: 1, length: 100, busy: false, complete: true, ...changes });

test('当前轮完成且稳定半秒后即可回传，不能把历史回答当成新回答', () => {
  const ready = createAnswerGate(1);
  assert.equal(ready(answer({ count: 1 }), 0), false);
  assert.equal(ready(answer(), 100), false);
  assert.equal(ready(answer(), 599), false);
  assert.equal(ready(answer(), 600), true);
});

test('生成中、等长替换和短暂读取失败都会重新计算稳定时间', () => {
  const ready = createAnswerGate(1);
  assert.equal(ready(answer(), 0), false);
  assert.equal(ready(answer({ busy: true }), 1000), false);
  assert.equal(ready(answer(), 2000), false);
  assert.equal(ready(answer({ revision: 2 }), 2500), false);
  assert.equal(ready(answer({ revision: 2 }), 3000), true);
  assert.equal(ready(null, 3100), false);
  assert.equal(ready(answer({ revision: 2 }), 4000), false);
  assert.equal(ready(answer({ revision: 2 }), 4500), true);
});

test('结束控件刚出现时仍确认半秒，缺失时保留三十秒保护', () => {
  const ready = createAnswerGate(1);
  assert.equal(ready(answer({ complete: false }), 0), false);
  assert.equal(ready(answer({ complete: false }), 29999), false);
  assert.equal(ready(answer(), 30000), false);
  assert.equal(ready(answer(), 30500), true);
  const quiet = createAnswerGate(1);
  assert.equal(quiet(answer({ complete: false }), 0), false);
  assert.equal(quiet(answer({ complete: false }), 30000), true);
});

test('最终提取期间正文继续变动或新消息出现时，不能返回旧快照', () => {
  const ready = createAnswerGate(1);
  ready(answer(), 0);
  assert.equal(ready(answer(), 500), true);
  assert.equal(ready(answer({ revision: 2 }), 501), false);
  assert.equal(ready(answer({ revision: 2 }), 1001), true);
  assert.equal(ready(answer({ count: 3, revision: 2 }), 1002), false);
});

test('轻量状态不读取 innerText，等长正文变化会更新版本，JSON 链接保持原文', t => {
  const previous = { document: global.document, snapshot: global.__easyreadAnswerSnapshot };
  t.after(() => { global.document = previous.document; global.__easyreadAnswerSnapshot = previous.snapshot; });
  let visibleReads = 0;
  const root = { textContent: '{"url":"https://example.com/a"}',
    get innerText() { visibleReads++; return this.textContent; } };
  let codeOnly = false;
  const turn = { querySelectorAll: () => [{ closest: () => codeOnly ? {} : null,
    getAttribute: name => name === 'aria-label' ? '复制' : null }] };
  const node = { getAttribute: () => null, querySelector: () => root, querySelectorAll: () => [], closest: () => turn };
  global.document = { querySelector: () => null };
  const first = readAnswer([node], false);
  assert.equal(first.complete, true);
  codeOnly = true;
  assert.equal(readAnswer([node], false).complete, false, '代码复制按钮不能表示回答完成');
  assert.equal(visibleReads, 0);
  assert.equal(readAnswer([node], false).revision, first.revision);
  root.textContent = '{"url":"https://example.com/b"}';
  assert.equal(readAnswer([node], false).revision, first.revision + 1);
  assert.equal(readAnswer([node]).text, root.textContent);
  assert.equal(visibleReads, 1);
});

test('代码块直接读取 code 原文，不混入复制按钮或重复遍历子树', t => {
  const previous = { document: global.document, Node: global.Node, snapshot: global.__easyreadAnswerSnapshot };
  t.after(() => { global.document = previous.document; global.Node = previous.Node;
    global.__easyreadAnswerSnapshot = previous.snapshot; });
  global.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
  const pre = { nodeType: 1, tagName: 'PRE', textContent: '复制代码{"value":1}',
    innerText: '复制代码\n{"value":1}', classList: { contains: () => false },
    closest: () => null, querySelector: () => ({ textContent: '{"value":1}' }),
    get childNodes() { throw new Error('不应递归遍历代码块'); } };
  const node = { getAttribute: () => null, querySelector: () => pre, querySelectorAll: () => [],
    closest: () => ({ querySelectorAll: () => [] }) };
  global.document = { querySelector: () => null };
  assert.equal(readAnswer([node]).text, '```\n{"value":1}\n```');
});

test('网页矩阵从 TeX 注解读取，保留换行并跳过视觉层和 SVG 文本', t => {
  const previous = { document: global.document, Node: global.Node, snapshot: global.__easyreadAnswerSnapshot };
  t.after(() => { global.document = previous.document; global.Node = previous.Node;
    global.__easyreadAnswerSnapshot = previous.snapshot; });
  global.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
  global.document = { querySelector: () => null };
  const tex = String.raw`\mathbf H_2=\frac{1}{\sqrt{2}}\begin{bmatrix}1&1\\1&-1\end{bmatrix}`;
  let display = true;
  const annotation = { nodeType: 1, tagName: 'ANNOTATION', textContent: tex,
    classList: { contains: () => false }, getAttribute: () => 'application/x-tex',
    closest: () => display ? {} : null };
  const math = { nodeType: 1, tagName: 'SPAN', classList: { contains: name => name === 'katex' },
    querySelector: () => annotation,
    get childNodes() { throw new Error('不能遍历公式视觉层'); } };
  const root = { nodeType: 1, tagName: 'DIV', textContent: 'H2=2svg11…', innerText: 'H2=2svg11…',
    classList: { contains: () => false }, closest: () => null, childNodes: [math] };
  const node = { getAttribute: () => null, querySelector: () => root, querySelectorAll: () => [],
    closest: () => ({ querySelectorAll: () => [] }) };
  assert.equal(readAnswer([node]).text, '$$' + tex + '$$');
  display = false;
  assert.equal(readAnswer([node]).text, '$' + tex + '$');
});

test('只有结果附件的回答也能等待稳定，不把卡片丢在正文之外', t => {
  const previous = global.document;
  t.after(() => { global.document = previous; });
  global.document = { querySelector: () => null };
  const node = { getAttribute: () => null, querySelector: () => ({ textContent: '' }),
    querySelectorAll: () => [{ getAttribute: () => `easyread-${'a'.repeat(32)}.json` }],
    closest: () => ({ querySelectorAll: () => [{ closest: () => null, getAttribute: () => 'copy' }] }) };
  const state = readAnswer([node], false);
  assert.equal(state.attachments, 1);
  const ready = createAnswerGate(0);
  assert.equal(ready(state, 0), false);
  assert.equal(ready(state, 500), true);
});

test('新版按钮卡片按文件标题参与稳定性判定，同文件多个标题只计一次', t => {
  const previous = global.document;
  t.after(() => { global.document = previous; });
  global.document = { querySelector: () => null };
  let name = `easyread-${'a'.repeat(32)}.json`;
  const title = { getAttribute: key => key === 'title' ? name : null };
  const node = { getAttribute: () => null, querySelector: () => ({ textContent: '' }),
    querySelectorAll: selector => selector.includes('[title]') ? [title, title] : [],
    closest: () => ({ querySelectorAll: () => [] }) };
  const state = readAnswer([node], false);
  assert.equal(state.attachments, 1);
  assert.equal(state.length, name.length);
  name = `easyread-${'b'.repeat(32)}.json`;
  assert.equal(readAnswer([node], false).revision, state.revision + 1);
});
