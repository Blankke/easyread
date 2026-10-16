/* 用法：node --test tests/desktop/test_chatgpt_resources.cjs；验证资料管理策略，不冒充真实网页验证。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { syncResource, projectFilesPage } = require('../../electron/chatgpt-resources.cjs');
const desired = { content_hash: 'hash', remote_name: 'EasyRead-glossary-hash.json', path: '/local/glossary.json' };
test('来源标签按 aria-controls 定位，等待列表加载并识别新版空列表', t => {
  const before = global.document;
  t.after(() => { global.document = before; });
  let selected = false, loading = true, clicks = 0;
  const rect = () => ({ width: 100, height: 30 });
  const label = text => ({ getAttribute: () => null, textContent: text, getBoundingClientRect: rect });
  const tab = { ...label('来源'), getAttribute: key => ({ 'aria-selected': String(selected), 'aria-controls': 'sources' })[key],
    click() { selected = true; clicks++; } };
  const input = { disabled: false, setAttribute(key, value) { this[key] = value; } };
  const panel = { getBoundingClientRect: rect, textContent: '为 ChatGPT 提供更多上下文 添加来源',
    querySelectorAll: selector => selector === '[role="status"]' ? loading ? [label('正在加载项目来源')] : [] :
      selector === 'h3' ? [label('为 ChatGPT 提供更多上下文')] : selector === 'input[type="file"]' ? [input] : [] };
  global.document = { querySelectorAll: selector => selector === '[role="tab"]' ? [tab] : [],
    getElementById: id => id === 'sources' ? panel : null };
  assert.equal(projectFilesPage('open'), true);
  assert.equal(projectFilesPage('open'), true);
  assert.equal(clicks, 1, '重复等待不能切换已打开的标签');
  assert.equal(projectFilesPage('list').retryable, true);
  loading = false;
  assert.deepEqual(projectFilesPage('list'), []);
  assert.equal(projectFilesPage('input'), true);
  assert.equal(input['data-easyread-project-upload'], 'true');
});
function fixture() {
  const state = { remote: [{ id: 'user', name: 'my-notes.pdf' }], uploads: 0, removed: [] };
  return { state, index: { entries: {}, retired: [] }, adapter: {
    list: async () => state.remote,
    upload: async (_file, name) => { state.uploads++; state.remote.push({ id: String(state.uploads), name }); },
    remove: async id => { state.removed.push(id); state.remote = state.remote.filter(x => x.id !== id); },
  } };
}
test('新版资料行以名称和上传时间核对身份，操作菜单只删除精确匹配的文件', t => {
  const before = global.document; t.after(() => { global.document = before; });
  const name = desired.remote_name, created = '2026-10-14T03:33:45.640Z';
  const rect = () => ({ width: 100, height: 30 });
  let expanded = false, removed = false, duplicate = false;
  const label = text => ({ textContent: text, getAttribute: () => null, getBoundingClientRect: rect });
  const menuButton = { ...label(name + ' 的操作'), getAttribute: key => key === 'aria-expanded' ? String(expanded) : null,
    click() { expanded = true; } };
  const removeButton = { ...label('删除'), click() { removed = true; } };
  const row = { getAttribute: () => null, getBoundingClientRect: rect,
    querySelector: selector => selector === '[title]' ? { getAttribute: () => name } :
      selector === 'time[datetime]' ? { getAttribute: () => created } : null,
    querySelectorAll: selector => selector === 'button[aria-haspopup="menu"]' ? [menuButton] : [] };
  const panel = { getBoundingClientRect: rect, textContent: name,
    querySelectorAll: selector => selector === 'li' ? removed ? [] : duplicate ? [row, row] : [row] :
      selector === 'h3' && removed ? [label('为 ChatGPT 提供更多上下文')] : [] };
  const tab = { ...label('来源'), getAttribute: key => key === 'aria-controls' ? 'sources' : key === 'aria-selected' ? 'true' : null };
  const menu = { getBoundingClientRect: rect, querySelectorAll: () => [removeButton] };
  global.document = { getElementById: () => panel,
    querySelectorAll: selector => selector === '[role="tab"]' ? [tab] : selector === '[role="menu"]' && expanded ? [menu] : [] };
  const id = JSON.stringify(['source', name, created]);
  assert.deepEqual(projectFilesPage('list'), [{ id, name, busy: false }]);
  assert.match(projectFilesPage('remove', { id: 'other', name }).error, /安全定位/);
  assert.equal(projectFilesPage('remove', { id, name }).retryable, true);
  assert.equal(projectFilesPage('remove', { id, name }), true);
  assert.deepEqual(projectFilesPage('list'), []);
  removed = false; duplicate = true;
  assert.match(projectFilesPage('list').error, /唯一标识/);
});
test('每次核对网页后复用相同版本，更新后只删除确认为自己上传的旧版本', async () => {
  const { state, index, adapter } = fixture();
  await syncResource(index, 'glossary', desired, adapter, () => {});
  await syncResource(index, 'glossary', desired, adapter, () => {});
  assert.equal(state.uploads, 1);
  await syncResource(index, 'glossary', { ...desired, content_hash: 'new', remote_name: 'EasyRead-glossary-new.json' }, adapter, () => {});
  assert.deepEqual(state.removed, ['1']);
  assert.equal(state.remote.length, 2);
  assert.ok(state.remote.some(x => x.id === 'user'));
});
test('重启后远程文件消失会重传，同名但归属不明不会盲目复用', async () => {
  const { state, index, adapter } = fixture();
  await syncResource(index, 'glossary', desired, adapter, () => {});
  state.remote = state.remote.filter(x => x.id === 'user');
  await syncResource(index, 'glossary', desired, adapter, () => {});
  assert.equal(state.uploads, 2);
  delete index.entries.glossary;
  await assert.rejects(syncResource(index, 'glossary', desired, adapter, () => {}), /同名/);
});
test('配额、上传失败和删除失败都保留可追溯状态', async () => {
  const { index, adapter } = fixture();
  await assert.rejects(syncResource(index, 'glossary', desired, adapter, () => {}, 1), /上限/);
  await assert.rejects(syncResource(index, 'glossary', desired, { ...adapter, upload: async () => {} }, () => {}), /未确认/);
  assert.equal(index.pending.status, 'uploading');
  assert.equal(index.entries.glossary, undefined);
  await syncResource(index, 'glossary', desired, adapter, () => {});
  await assert.rejects(syncResource(index, 'glossary', { ...desired, remote_name: 'new', content_hash: 'new' },
    { ...adapter, remove: async () => {} }, () => {}), /删除未确认/);
  assert.equal(index.entries.glossary.content_hash, 'new');
  assert.equal(index.retired.length, 1);
});
