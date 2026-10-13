/*
 * 用法：chatgpt-web.cjs 将 readAnswer 序列化到网页，使用 createAnswerGate 等待回答稳定。
 * 测试：node --test tests/desktop/test_chatgpt_answer.cjs。
 * 生成时仅回传状态；完整正文在完成后提取一次，正常执行与恢复任务共用判定。
 */
function readAnswer(list, full = true) {
  const node = list.at(-1);
  const busy = !!document.querySelector('[data-testid*="stop-button"], button[aria-label*="Stop"], button[aria-label*="停止"]') ||
    node?.getAttribute('aria-busy') === 'true';
  if (!node) return { text: '', length: 0, revision: 0, count: 0, busy, complete: false };
  const root = node.querySelector('.markdown, .prose, [data-testid="message-text"]') ||
    (node.querySelector('h4.sr-only') ? node.querySelector('h4.sr-only').parentElement?.children[1] : null) || node;
  const turn = node.closest('[data-testid^="conversation-turn-"], article') || node.parentElement?.parentElement || node.parentElement || node;
  // 代码块生成到一半也可能显示复制按钮，只有消息级操作才算完成信号。
  const complete = [...turn.querySelectorAll('button')].some(el => !el.closest('pre') && /copy|复制|regenerate|重新生成/i.test(
    [el.getAttribute('data-testid'), el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' ')));
  const raw = root.textContent || '';
  // 比较内容而非仅比较长度；等长替换、公式重绘也会更新版本。缓存仅保留最近一条回答。
  const previous = globalThis.__easyreadAnswerSnapshot;
  const revision = previous && previous.node === node && previous.raw === raw
    ? previous.revision : (previous?.revision || 0) + 1;
  globalThis.__easyreadAnswerSnapshot = { node, raw, revision };
  const state = { text: '', length: raw.trim().length, revision, count: list.length, busy, complete };
  if (!full) return state;
  // JSON 中的自动链接保留原文字；普通问答保留 Markdown 与 TeX 语义。
  const plain = (root.innerText || raw).trim();
  function md(el) {
    if (el.nodeType === Node.TEXT_NODE) return el.textContent;
    if (el.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = el.tagName.toLowerCase();
    if (el.classList.contains('katex')) {
      const tex = el.querySelector('annotation[encoding="application/x-tex"]');
      if (tex) return md(tex);
    }
    if (tag === 'annotation' && el.getAttribute('encoding') === 'application/x-tex') {
      const fence = el.closest('.katex-display') ? '$$' : '$';
      return fence + el.textContent + fence;
    }
    if (el.closest('.katex-html') || tag === 'button') return '';
    // 先处理代码块再递归，避免重复遍历长 JSON，也避免混入“复制代码”按钮文字。
    if (tag === 'pre') return '\n```\n' + (el.querySelector('code')?.textContent || el.innerText) + '\n```\n';
    const body = [...el.childNodes].map(md).join('');
    if (tag === 'code') return '`' + body + '`';
    if (tag === 'strong' || tag === 'b') return '**' + body + '**';
    if (tag === 'em' || tag === 'i') return '*' + body + '*';
    if (tag === 'a') return '[' + body + '](' + el.href + ')';
    if (/^h[1-6]$/.test(tag)) return '\n' + '#'.repeat(Number(tag[1])) + ' ' + body + '\n';
    if (tag === 'p' || tag === 'div' || tag === 'li') return body + '\n';
    return body;
  }
  return { ...state, text: /^[\[{]/.test(plain) ? plain : md(root).trim() };
}

function createAnswerGate(beforeCount) {
  let previous, quietSince = 0, completeSince = null;
  return (state, now = Date.now()) => {
    if (!state || state.count <= beforeCount || !state.length || state.busy) {
      previous = undefined;
      completeSince = null;
      return false;
    }
    if (!previous || state.count !== previous.count || state.revision !== previous.revision || state.length !== previous.length) {
      quietSince = now;
      completeSince = null;
    }
    if (!state.complete) completeSince = null;
    else if (completeSince === null) completeSince = now;
    previous = state;
    // 明确出现结束控件后再确认半秒；缺少结束控件时仍保留 30 秒静默保护。
    return state.complete ? now - completeSince >= 500 : now - quietSince >= 30000;
  };
}

module.exports = { readAnswer, createAnswerGate };
