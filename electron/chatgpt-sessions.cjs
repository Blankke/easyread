/*
 * 用法：网页执行器在发送前调用 nextSession，完成时调用 completeSession。
 * 测试：node --test tests/desktop/test_chatgpt_sessions.cjs。
 * 当前会话仍在顶层，history 保存归档会话；旧版单会话记录可直接读取。
 */
const { randomUUID } = require('node:crypto');
function shouldRotate(saved, options = {}) {
  if (!saved || saved.pending) return false;
  if (saved.rotate_next) return true;
  if (options.rotate_enabled === false) return false;
  return (saved.requests || 0) >= (options.rotate_requests || 12) ||
    (saved.pages || 0) >= (options.rotate_pages || 48) ||
    (options.rotate_messages > 0 && (saved.messages || 0) >= options.rotate_messages);
}
function nextSession(saved, rotate = false) {
  if (saved?.pending && rotate) throw new Error('待确认任务尚未处理，不能轮换会话');
  if (saved && !rotate) return { ...saved, schema: 2, id: saved.id || randomUUID(), history: saved.history || [] };
  const history = [...(saved?.history || [])];
  if (saved?.url) {
    const { history: _history, rotate_next: _rotate, ...old } = saved;
    history.push({ ...old, status: 'archived', archived_at: new Date().toISOString() });
  }
  return { schema: 2, id: randomUUID(), requests: 0, pages: 0, messages: 0, files: {}, history,
    created_at: new Date().toISOString() };
}
function completeSession(saved, messageCount) {
  // 请求计数在提交前持久化，恢复时只移除 pending，避免重复计算。
  const result = { ...saved, messages: messageCount * 2 };
  // 附件先随待回收任务持久化；成功交付才确认其已进入会话，失败草稿不会污染后续复用。
  if (saved.pending?.files) result.files = { ...saved.pending.files };
  delete result.pending;
  return result;
}
function atomicJSON(file, data) {
  const fs = require('node:fs'), path = require('node:path');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(data), 'utf8'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
}
function pendingRecord(pending) {
  // 只允许更新当前论文内、本地生成的任务记录，不能跟随索引中的任意路径。
  const fs = require('node:fs'), path = require('node:path');
  if (!pending?.task_record || !pending.cwd || !pending.task_id) return null;
  const root = fs.realpathSync(pending.cwd), file = fs.realpathSync(pending.task_record);
  if (path.dirname(file) !== path.join(root, 'web-tasks') || !/^[a-f0-9]{64}\.json$/.test(path.basename(file)))
    throw new Error('待确认任务记录路径不属于当前论文');
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (record.task_id !== pending.task_id || record.source_sha256 !== pending.source_sha256)
    throw new Error('待确认任务记录归属不符');
  return { file, record };
}

function releasePending(pending, reason) {
  const saved = pendingRecord(pending);
  if (!saved) return;
  // 后端已接收的正文仍可继续解析；只有确实获准重发的任务才作废。
  if (saved.record.status === 'received') return;
  atomicJSON(saved.file, { ...saved.record, status: 'rejected', release_reason: reason,
    released_at: new Date().toISOString() });
}
module.exports = { shouldRotate, nextSession, completeSession, atomicJSON, pendingRecord, releasePending };
