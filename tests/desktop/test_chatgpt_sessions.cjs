/* 用法：node --test tests/desktop/test_chatgpt_sessions.cjs；验证会话轮换与旧映射保留。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shouldRotate, nextSession, completeSession, releasePending, pendingRecord } = require('../../electron/chatgpt-sessions.cjs');
test('请求、页数、消息阈值及关闭开关', () => {
  assert.equal(shouldRotate({ requests: 11, pages: 44 }), false);
  assert.equal(shouldRotate({ requests: 12 }), true);
  assert.equal(shouldRotate({ pages: 48 }), true);
  assert.equal(shouldRotate({ messages: 20 }, { rotate_messages: 20 }), true);
  assert.equal(shouldRotate({ requests: 12 }, { rotate_enabled: false }), false);
  assert.equal(shouldRotate({ rotate_next: true }, { rotate_enabled: false }), true);
});
test('pending 任务禁止自动和手动轮换', () => {
  const saved = { requests: 30, rotate_next: true, pending: { task_id: 'old' } };
  assert.equal(shouldRotate(saved), false);
  assert.throws(() => nextSession(saved, true), /待确认/);
});
test('待回收附件仅在成功交付后成为已提交的会话附件', () => {
  const saved = { files: { pdf: 'confirmed' }, pending: { task_id: 'new', files: { pdf: 'confirmed', page: 'new' } } };
  const completed = completeSession(saved, 2);
  assert.deepEqual(saved.files, { pdf: 'confirmed' });
  assert.deepEqual(completed.files, { pdf: 'confirmed', page: 'new' });
  assert.equal(completed.pending, undefined);
  completed.files.page = 'changed';
  assert.equal(saved.pending.files.page, 'new');
});
test('旧单会话迁移，轮换保存全部历史，恢复不重复计数', () => {
  const old = nextSession({ url: 'https://chatgpt.com/g/g-p-test/c/old', files: { pdf: 'hash' } });
  assert.equal(old.schema, 2);
  const next = nextSession(old, true);
  assert.equal(next.history[0].url, old.url);
  assert.equal(next.history[0].status, 'archived');
  assert.notEqual(next.id, old.id);
  assert.deepEqual(next.files, {});
  const completed = completeSession({ ...next, requests: 1, pending: { task_id: 'new' } }, 1);
  assert.equal(completed.requests, 1);
  assert.equal(completed.pending, undefined);
  assert.equal(completed.history.length, 1);
});

test('明确允许重试同步作废后端记录，但保留已接收结果并核对路径归属', t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'easyread-release-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, 'web-tasks'));
  const task_record = path.join(cwd, 'web-tasks', `${'a'.repeat(64)}.json`);
  const record = { task_id: 'b'.repeat(32), source_sha256: 'c'.repeat(64), status: 'pending' };
  const pending = { ...record, cwd, task_record };
  fs.writeFileSync(task_record, JSON.stringify(record));
  releasePending(pending, 'user-confirmed-retry');
  assert.equal(pendingRecord(pending).record.status, 'rejected');
  fs.writeFileSync(task_record, JSON.stringify({ ...record, status: 'received', text: '{}' }));
  releasePending(pending, 'user-confirmed-retry');
  assert.equal(pendingRecord(pending).record.status, 'received');
  assert.throws(() => pendingRecord({ ...pending, source_sha256: 'other' }), /归属/);
  assert.throws(() => pendingRecord({ ...pending, task_record: cwd }), /路径/);
});
