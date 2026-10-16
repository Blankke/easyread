/* 用法：node --test tests/web/test_web_translation_settings.cjs；验证网页配置保存和人工轮换入口。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

test('文件模式数值与开关按类型保存，切换模型保留网页选项', async () => {
  let inputs = [];
  const PR = { t: x => x, esc: String, icon: () => '', settingsTabs: {},
    $: () => ({ addEventListener() {} }), $$: () => inputs,
    opt: (items, current) => items.map(([key, label]) => `<option value="${key}"${key === current ? ' selected' : ''}>${label}</option>`).join(''),
    settingsRender() {}, saveModelSettings() {}, menu: (_el, items) => { PR.menuItems = items; } };
  const rotations = [];
  const desktop = { chatgptRotate: async key => rotations.push(key), chatgptStatus: async () => ({ ready: true }) };
  const context = { window: { PR, easyreadDesktop: desktop, addEventListener() {} }, document: { addEventListener() {} } };
  for (const name of ['settings.js', 'settings-chat.js'])
    vm.runInNewContext(fs.readFileSync(`easyread/web/js/common/${name}`, 'utf8'), context);
  PR.saveModelSettings = () => {};
  PR.settingsRender = () => {};
  const state = { pinned: true, transChecked: true, cfg: { engine: 'chatgpt_web', chatgpt_web: {
    model: 'Old', output_mode: 'file', file_batch_pages: 8, project_sync: true, rotate_enabled: false } },
    chat: { models: [{ id: 'new', engine: 'chatgpt_web', model: 'New', name: 'New' }] } };
  const html = PR.settingsTabs.chat.render(state);
  assert.match(html, /value="file" selected/);
  assert.match(html, /data-k="chatgpt_web.file_batch_pages" value="8"/);
  const click = (selector, dataset) => PR.settingsTabs.chat.click({ target: {
    closest: wanted => wanted === selector ? { dataset } : null } }, state);
  await click('[data-cm]', { cm: 'more', i: '0' });
  PR.menuItems[0].fn();
  assert.equal(state.cfg.chatgpt_web.model, 'New');
  assert.equal(state.cfg.chatgpt_web.file_batch_pages, 8);
  inputs = [{ dataset: { k: 'chatgpt_web.file_batch_pages' }, type: 'number', value: '12' },
    { dataset: { k: 'chatgpt_web.project_sync' }, type: 'checkbox', checked: false }];
  PR.settingsTabs.chat.sync(state);
  assert.equal(state.cfg.chatgpt_web.file_batch_pages, 12);
  assert.equal(state.cfg.chatgpt_web.project_sync, false);
  await click('[data-web-action]', { webAction: 'rotate', webSession: 'paper/translation' });
  assert.deepEqual(rotations, ['paper/translation']);
});
