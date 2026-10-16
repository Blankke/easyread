/* 用法：node --test tests/desktop/test_chatgpt_artifacts.cjs；验证下载归属、失败清理和重启恢复。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { validateArtifact, artifactPath, readArtifact, artifactLink, createArtifactCollector } = require('../../electron/chatgpt-artifacts.cjs');
const task = { protocol: 'easyread-translation-v1', task_id: 'a'.repeat(32), source_sha256: 'b'.repeat(64), requested_pages: [1, 2] };
const result = () => ({ ...task, status: 'complete', result: { meta: {}, glossary: [], references: [], checks: [],
  blocks: [{ id: 'p1', page: 1, type: 'para', en: 'Source', zh: '译文' }] } });
test('通用下载标签按链接的精确文件名绑定任务，拒绝其他任务与多义入口', () => {
  const link = { textContent: '下载 JSON 文件', href: `sandbox:/mnt/data/easyread-${task.task_id}.json`,
    getAttribute: () => null, getBoundingClientRect: () => ({ width: 100, height: 20 }) };
  let links = [link];
  const answers = [{ querySelectorAll: () => links }];
  assert.equal(artifactLink(answers, task.task_id, 0).found, true);
  assert.equal(artifactLink(answers, 'f'.repeat(32), 0).found, false);
  links = [link, link];
  assert.equal(artifactLink(answers, task.task_id, 0).reason, 'ambiguous');
});
function setup(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'easyread-artifact-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const wc = new EventEmitter(); wc.session = new EventEmitter();
  const collector = createArtifactCollector(wc); t.after(() => collector.close());
  const link = { href: 'https://chatgpt.com/result', name: `easyread-${task.task_id}.json` };
  const item = new EventEmitter();
  Object.assign(item, { getURLChain: () => [link.href], getFilename: () => link.name,
    getTotalBytes: () => 200, getReceivedBytes: () => 200,
    setSavePath: file => { item.path = file; }, cancel: () => { item.cancelled = true; } });
  return { cwd, wc, collector, link, item };
}
test('新版文件卡片精确定位下载按钮，并拒绝同回答中的重复文件', () => {
  let clicked = 0;
  const name = `easyread-${task.task_id}.json`;
  const download = { getAttribute: () => '下载文件', getBoundingClientRect: () => ({ width: 32 }), click: () => clicked++ };
  const preview = { getAttribute: () => `打开 ${name} 的预览` };
  const row = { querySelectorAll: () => [preview, download] };
  const title = { getAttribute: () => name, parentElement: row };
  let titles = [title];
  const answer = { querySelectorAll: selector => selector === '[title]' ? titles : [] };
  row.parentElement = answer;
  assert.equal(artifactLink([answer], task.task_id, 0, true).kind, 'resource-button');
  assert.equal(clicked, 1);
  assert.equal(artifactLink([answer], 'f'.repeat(32), 0).found, false);
  const second = { ...download };
  titles = [title, { ...title, parentElement: { querySelectorAll: () => [preview, second], parentElement: answer } }];
  assert.equal(artifactLink([answer], task.task_id, 0).reason, 'ambiguous');
});
test('无公开 URL 的卡片下载只接收当前网页的精确任务文件', async t => {
  const { cwd, wc, collector, link, item } = setup(t);
  link.kind = 'resource-button'; link.href = '';
  item.getURLChain = () => ['blob:https://chatgpt.com/generated'];
  const saved = await collector.collect({ cwd, task, link, click() {
    wc.session.emit('will-download', {}, item, new EventEmitter());
    assert.equal(item.path, undefined);
    item.getFilename = () => `easyread-${'f'.repeat(32)}.json`;
    wc.session.emit('will-download', {}, item, wc);
    assert.equal(item.path, undefined);
    item.getFilename = () => link.name;
    wc.session.emit('will-download', {}, item, wc);
    fs.writeFileSync(item.path, JSON.stringify(result())); item.emit('done', {}, 'completed');
  } });
  assert.deepEqual(saved.value, result());
});
test('完整信封通过；损坏、缺字段、跨任务、范围外和重复 ID 均拒绝', () => {
  assert.deepEqual(validateArtifact(result(), task), result());
  for (const field of ['protocol', 'task_id', 'source_sha256', 'requested_pages', 'status']) {
    const bad = result(); bad[field] = 'wrong'; assert.throws(() => validateArtifact(bad, task));
  }
  for (const field of ['meta', 'blocks']) {
    const bad = result(); delete bad.result[field]; assert.throws(() => validateArtifact(bad, task));
  }
  for (const field of ['checks', 'references', 'glossary']) {
    const bad = result(); bad.result[field] = null; assert.throws(() => validateArtifact(bad, task));
  }
  const bad = result(); bad.result.blocks[0].page = 3; assert.throws(() => validateArtifact(bad, task));
  const duplicate = result(); duplicate.result.blocks.push({ ...duplicate.result.blocks[0] });
  assert.throws(() => validateArtifact(duplicate, task));
});
test('续批按论文协议省略元数据和无内容数组，原文件保持不变；正文和引用仍须完整', () => {
  const later = { ...task, requested_pages: [13, 14] };
  const value = { ...later, status: 'complete', result: { blocks: [{ id: 'p13', page: 13, type: 'para', en: 'Source', zh: '译文' }] } };
  const normalized = validateArtifact(value, later);
  assert.deepEqual(normalized.result.meta, {});
  assert.deepEqual(normalized.result.references, []);
  assert.deepEqual(Object.keys(value.result), ['blocks']);
  value.result.blocks[0].type = 'references';
  assert.throws(() => validateArtifact(value, later), /references/);
});
test('下载完成、校验并保存后可离线复用；不再次触发下载', async t => {
  const { cwd, wc, collector, link, item } = setup(t), stages = [];
  const downloaded = await collector.collect({ cwd, task, link, report: async phase => stages.push(phase), click() {
    wc.session.emit('will-download', {}, item, wc);
    fs.writeFileSync(item.path, JSON.stringify(result()));
    item.emit('done', {}, 'completed');
  } });
  assert.deepEqual(downloaded.value, result());
  assert.deepEqual(stages, ['downloading', 'downloaded', 'validated']);
  assert.equal(wc.session.listenerCount('will-download'), 0);
  const recovered = await collector.collect({ cwd, task, link, click() { assert.fail('不得重复下载'); } });
  assert.equal(recovered.recovered, true);
});
for (const failure of ['cancelled', 'interrupted', 'bad-json', 'wrong-task', 'timeout', 'oversize']) {
  test(`下载失败安全退出：${failure}`, async t => {
    const { cwd, wc, collector, link, item } = setup(t);
    if (failure === 'oversize') item.getTotalBytes = () => 33 * 1024 * 1024;
    await assert.rejects(collector.collect({ cwd, task, link, timeout: 30, click() {
      wc.session.emit('will-download', {}, item, wc);
      if (!item.path) return;
      const body = result(); if (failure === 'wrong-task') body.task_id = 'c'.repeat(32);
      fs.writeFileSync(item.path, failure === 'bad-json' ? '{broken' : JSON.stringify(body));
      if (failure !== 'timeout') item.emit('done', {}, ['bad-json', 'wrong-task'].includes(failure) ? 'completed' : failure);
    } }));
    const remaining = fs.readdirSync(path.join(cwd, 'web-artifacts'));
    if (['bad-json', 'wrong-task'].includes(failure)) {
      assert.equal(remaining.length, 1);
      assert.ok(remaining[0].endsWith('.invalid'), '不合格的原始附件保留供诊断，不进入正式结果路径');
    } else assert.equal(remaining.length, 0);
    assert.equal(wc.session.listenerCount('will-download'), 0);
  });
}
test('非当前 WebContents 和非当前 URL 的下载不能被误接收', async t => {
  const { cwd, wc, collector, link, item } = setup(t);
  await assert.rejects(collector.collect({ cwd, task, link, timeout: 15, click() {
    wc.session.emit('will-download', {}, item, new EventEmitter());
    item.getURLChain = () => ['https://chatgpt.com/other'];
    wc.session.emit('will-download', {}, item, wc);
  } }));
  assert.equal(item.path, undefined);
  assert.equal(item.cancelled, undefined, '不干预用户的其他下载');
});
test('父页面创建的子窗口可触发当前任务下载', async t => {
  const { cwd, wc, collector, link, item } = setup(t);
  const child = new EventEmitter(); child.webContents = new EventEmitter();
  wc.emit('did-create-window', child);
  await collector.collect({ cwd, task, link, click() {
    wc.session.emit('will-download', {}, item, child.webContents);
    fs.writeFileSync(item.path, JSON.stringify(result())); item.emit('done', {}, 'completed');
  } });
});
test('保存路径拒绝穿越、符号链接及损坏的已下载文件', t => {
  const { cwd } = setup(t);
  assert.throws(() => artifactPath(cwd, '../source.pdf'));
  const file = artifactPath(cwd, task.task_id);
  fs.writeFileSync(file, '{'); assert.throws(() => readArtifact(file, task));
  const elsewhere = path.join(cwd, 'external'); fs.mkdirSync(elsewhere);
  const nested = path.join(cwd, 'nested'); fs.mkdirSync(nested);
  try { fs.symlinkSync(elsewhere, path.join(nested, 'web-artifacts'), 'junction'); }
  catch (error) { if (error.code === 'EPERM') return; throw error; }
  assert.throws(() => artifactPath(nested, task.task_id));
});
