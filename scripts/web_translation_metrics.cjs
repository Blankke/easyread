/*
 * 用法：node scripts/web_translation_metrics.cjs library/<论文ID> [library/<另一篇ID> ...]
 * 可将 stdout 重定向到临时目录下的 .jsonl 文件保存实测数据；每个目录在 stderr 显示读取进度。
 * 只读取本地任务记录，输出页数、阶段耗时与结果统计，不输出论文正文、提示词或凭据。
 * 比较 text/file 的 4、8、12 页测试时，请为每组使用独立导入的测试论文并在设置中选定模式和批量。
 */
const fs = require('node:fs');
const path = require('node:path');

function measurements(root) {
  const dir = path.join(root, 'web-tasks');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => name.endsWith('.json')).map(name => {
    const record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    const m = record.metrics || {};
    const runs = Object.values(record.metric_runs || { last: m });
    // 重启回收没有上传/发送阶段，必须从原执行记录累计，不能把已测耗时覆盖为空。
    const duration = (start, end) => {
      const measured = runs.filter(run => Number.isFinite(run[start]) && Number.isFinite(run[end]));
      return measured.length ? measured.reduce((total, run) => total + Math.max(0, run[end] - run[start]), 0) : null;
    };
    return { task_id: record.task_id, mode: record.output_mode, requested_pages: record.requested_pages?.length || 0,
      requests_sent: runs.reduce((n, run) => n + (run.requests_sent || 0), 0), recovered: runs.some(run => run.recovered),
      recovery_attempts: runs.filter(run => run.recovered).length,
      failed_attempts: runs.filter(run => Number.isFinite(run.failed_ms)).length,
      upload_ms: duration('history-ready', 'attachments-ready'), generation_ms: duration('after-send', 'answer-ready'),
      collection_ms: duration('answer-ready', 'completed_ms'), total_ms: m.completed_ms ?? null,
      parse_merge_ms: record.parse_merge_ms ?? null, effective_pages: record.merged_pages?.length || 0,
      missing_pages: record.missing_pages?.length ?? null, status: record.status,
      artifact_status: record.artifact_status || 'text', failed: !!record.error, retry_count: record.retry_count || 0,
      completion_rate: record.requested_pages?.length ? (record.merged_pages?.length || 0) / record.requested_pages.length : null };
  });
}

if (require.main === module) {
  const roots = process.argv.slice(2);
  if (!roots.length) { console.error('用法：node scripts/web_translation_metrics.cjs library/<论文ID> [...]'); process.exitCode = 1; }
  for (const [i, root] of roots.entries()) {
    console.error(`[${i + 1}/${roots.length}] 读取网页任务性能记录`);
    for (const record of measurements(path.resolve(root))) console.log(JSON.stringify(record));
  }
}
module.exports = { measurements };
