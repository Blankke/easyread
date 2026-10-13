const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('named connections persist, default names increment, and switching isolates keys', () => {
  const PR = { t: (s, v = {}) => s.replace(/\{(\w+)\}/g, (_, k) => v[k]), toast() {},
    apiKeyId: (_, url) => 'url:' + url.replace(/\/+$/, ''), apiHasKey: () => true };
  vm.runInNewContext(fs.readFileSync('easyread/web/js/common/settings-custom-apis.js', 'utf8'), { window: { PR } });
  const state = { cfg: { openai: {} }, chat: { models: [] } };
  const a = { base_url: 'https://a.example/v1', api: 'chat', key: 'fake-a' };
  const b = { base_url: 'https://b.example/v1', api: 'responses', key: 'fake-b' };
  assert.equal(PR.customApis.save(state, a, 'key'), true);
  assert.equal(PR.customApis.save(state, b, 'key'), true);
  assert.equal(a.connection_name, PR.t('自定义 API {n}', { n: 1 }));
  assert.equal(b.connection_name, PR.t('自定义 API {n}', { n: 2 }));
  a.connection_name = 'Research'; PR.customApis.save(state, a, 'key');
  assert.equal(state.cfg.openai.custom_apis.length, 2);
  assert.equal(state.chatKeys['url:https://a.example/v1'], 'fake-a');
  const reloaded = JSON.parse(JSON.stringify(state));
  PR.customApis.select(reloaded, a, '1', 'key');
  assert.equal(a.base_url, b.base_url);
  assert.equal(a.api, 'responses');
  assert.equal(a.key, '••••');
  assert.equal(a.model, '');
  assert.ok(!JSON.stringify(state.cfg.openai.custom_apis).includes('fake-'));
});
