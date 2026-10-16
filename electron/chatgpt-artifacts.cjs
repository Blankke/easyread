/*
 * 用法：网页执行器通过 createArtifactCollector(wc) 接收当前回答的 JSON 附件。
 * 测试：node --test tests/desktop/test_chatgpt_artifacts.cjs。
 * 仅监听 Electron 官方下载事件；远程文件只作 JSON 数据，路径完全由本地生成。
 */
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const MAX_BYTES = 32 * 1024 * 1024;

function validateArtifact(value, task) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('结果文件必须是 JSON 对象');
  for (const key of ['protocol', 'task_id', 'source_sha256', 'requested_pages']) {
    if (JSON.stringify(value[key]) !== JSON.stringify(task[key])) throw new Error(`结果文件任务归属不符：${key}`);
  }
  if (value.status !== 'complete') throw new Error('结果文件尚未完整交付');
  const result = value.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('结果必须是对象');
  // 与论文块协议一致：续批不必重复标题元数据，无引用/检查/新术语时可省略对应字段。
  // 只补空容器，不补写论文内容；首批元数据和有参考文献块时的条目仍为必需。
  const normalized = { ...result, meta: result.meta === undefined && !task.requested_pages.includes(1) ? {} : result.meta };
  if (!normalized.meta || typeof normalized.meta !== 'object' || Array.isArray(normalized.meta)) throw new Error('结果缺少 meta 对象');
  for (const key of ['blocks', 'glossary', 'references', 'checks']) {
    const required = key === 'blocks' || key === 'references' && result.blocks?.some?.(block => block?.type === 'references');
    normalized[key] = result[key] === undefined && !required ? [] : result[key];
    if (!Array.isArray(normalized[key]) || normalized[key].some(x => !x || typeof x !== 'object' || Array.isArray(x)))
      throw new Error(`结果缺少有效的 ${key} 数组`);
  }
  const ids = new Set();
  for (const block of normalized.blocks) {
    if (typeof block.id !== 'string' || !block.id || ids.has(block.id)) throw new Error('结果文件的块 ID 缺失或重复');
    ids.add(block.id);
    if (!Number.isInteger(block.page) || !task.requested_pages.includes(block.page)) throw new Error('结果文件包含任务范围外的块');
  }
  return { ...value, result: normalized };
}

function artifactPath(cwd, taskId) {
  if (!/^[a-f0-9]{32}$/.test(taskId)) throw new Error('无效的文件任务编号');
  const root = fs.realpathSync(cwd);
  const dir = path.join(root, 'web-artifacts');
  fs.mkdirSync(dir, { recursive: true });
  if (fs.lstatSync(dir).isSymbolicLink() || fs.realpathSync(dir) !== dir) throw new Error('结果目录不能是符号链接');
  const target = path.join(dir, `${taskId}.json`);
  if (fs.existsSync(target) && (!fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink()))
    throw new Error('结果路径不是普通文件');
  return target;
}

function readArtifact(file, task) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_BYTES) throw new Error('结果文件大小或类型不合法');
  return validateArtifact(JSON.parse(fs.readFileSync(file, 'utf8')), task);
}

// 序列化至网页；调用方传入统一定位的回答列表，只允许唯一的本任务文件名。
function artifactLink(answers, taskId, beforeCount, click = false) {
  if (answers.length !== beforeCount + 1) return { found: false, reason: 'answer-count' };
  const name = `easyread-${taskId}.json`;
  const answer = answers.at(-1);
  const candidates = [...answer.querySelectorAll('a[href]')].filter(el => {
    const label = [el.textContent, el.getAttribute('download'), el.getAttribute('aria-label')].filter(Boolean).join(' ');
    const rect = el.getBoundingClientRect();
    // 网页常把附件显示为“下载 JSON 文件”；仍可从已有链接的精确文件名核对任务。
    let filename = '';
    try { filename = decodeURIComponent(new URL(el.href).pathname.split('/').pop()); } catch (_) { /* 无法解析则只核对标签。 */ }
    return rect.width > 0 && rect.height > 0 && (label.split(/\s+/).includes(name) || filename === name);
  }).map(el => ({ el, href: el.href, kind: 'link' }));
  // 新版资源卡片用按钮下载，没有 href。以精确文件名定位卡片，再限定到同一卡片的下载按钮。
  const buttons = new Set();
  for (const title of answer.querySelectorAll('[title]')) {
    if (title.getAttribute('title') !== name) continue;
    for (let row = title.parentElement; row && row !== answer; row = row.parentElement) {
      const previews = [...row.querySelectorAll('button[aria-label]')].filter(el => {
        const label = el.getAttribute('aria-label') || '';
        return label.includes(name) && /预览|preview/i.test(label);
      });
      if (!previews.length) continue;
      const downloads = [...row.querySelectorAll('button[aria-label]')].filter(el =>
        /^(下载文件|Download file)$/i.test((el.getAttribute('aria-label') || '').trim()));
      if (previews.length === 1 && downloads.length === 1 && !downloads[0].disabled &&
          downloads[0].getBoundingClientRect().width > 0) buttons.add(downloads[0]);
      break;
    }
  }
  for (const el of buttons) candidates.push({ el, href: '', kind: 'resource-button' });
  if (candidates.length !== 1) return { found: false, reason: candidates.length ? 'ambiguous' : 'missing' };
  const link = candidates[0];
  const { href, kind } = link;
  // 只点击网站已经显示的附件入口，不构造或访问网站的内部下载接口。
  if (kind === 'link' && !/^(https:|blob:|sandbox:)/.test(href)) return { found: false, reason: 'scheme' };
  if (click) link.el.click();
  return { found: true, href, name, kind };
}

function createArtifactCollector(wc) {
  let active = null;
  const children = new Set();
  const childListener = child => { children.add(child.webContents); child.once('closed', () => children.delete(child.webContents)); };
  wc.on('did-create-window', childListener);

  function collect({ cwd, task, link, click, report = async () => {}, timeout = 90000, cancelled = () => false }) {
    if (active) throw new Error('已有文件正在回收');
    const target = artifactPath(cwd, task.task_id);
    if (fs.existsSync(target)) return Promise.resolve({ value: readArtifact(target, task), path: target, recovered: true });
    if (!wc.session?.on) throw new Error('Electron 下载会话不可用');
    const temporary = `${target}.${randomUUID()}.part`;
    return new Promise((resolve, reject) => {
      let item, settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); clearInterval(poll);
        wc.session.removeListener('will-download', receive);
        active = null;
        if (error) {
          item?.cancel();
          // 只清理本次由 EasyRead 随机创建的临时文件。
          try { fs.unlinkSync(temporary); } catch (_) { /* 文件可能尚未创建。 */ }
          reject(error);
        } else resolve(value);
      };
      const receive = (_event, candidate, source) => {
        if (process.env.EASYREAD_WEB_TRACE === '1') console.log('ChatGPT 附件下载事件', JSON.stringify({
          filename: candidate.getFilename().slice(0, 120), currentPage: source === wc,
          childPage: children.has(source), schemes: candidate.getURLChain().map(url => url.split(':')[0]),
          expectedName: candidate.getFilename() === link.name }));
        if (item || !(source === wc || children.has(source))) return;
        const chain = candidate.getURLChain();
        // sandbox 链接经网站转换后 URL 会变化；此时还要求下载名含不可猜的任务 ID。
        const urlMatch = chain.includes(link.href);
        // 按钮没有公开 URL；仍须来自当前网页、文件名精确匹配随机任务 ID，落盘后再次验证完整信封。
        const cardDownload = link.kind === 'resource-button' && link.href === '' && source === wc;
        if (candidate.getFilename() !== link.name || (!urlMatch && !link.href.startsWith('sandbox:') && !cardDownload)) return;
        item = candidate;
        try {
          if (item.getTotalBytes() > MAX_BYTES) throw new Error('结果附件超过 32 MiB');
          item.setSavePath(temporary);
          Promise.resolve(report('downloading')).catch(error => finish(error));
          item.on('updated', (_e, state) => {
            if (state === 'interrupted' || item.getReceivedBytes() > MAX_BYTES)
              finish(new Error(state === 'interrupted' ? '结果附件下载中断' : '结果附件超过 32 MiB'));
          });
          item.once('done', async (_e, state) => {
            if (settled) return;
            try {
              if (state !== 'completed') throw new Error(`结果附件下载未完成：${state}`);
              // 独占创建最终文件，不覆盖任何已有文件；崩溃后的完整文件可再次验证回收。
              fs.copyFileSync(temporary, target, fs.constants.COPYFILE_EXCL);
              fs.unlinkSync(temporary);
              await report('downloaded');
              if (settled) return;
              let value;
              try { value = readArtifact(target, task); }
              catch (error) {
                // 下载成功但结构不合格时保留原始文件，供诊断及修复交付；不作为已接收结果合并。
                const invalid = `${target}.${randomUUID()}.invalid`;
                fs.renameSync(target, invalid);
                if (process.env.EASYREAD_WEB_TRACE === '1') console.warn('ChatGPT 未通过校验的附件', invalid);
                throw error;
              }
              await report('validated');
              if (settled) return;
              finish(null, { value, path: target });
            } catch (error) { finish(error); }
          });
        } catch (error) { finish(error); }
      };
      const timer = setTimeout(() => finish(new Error('结果附件下载超时；保留原会话供重新回收')), timeout);
      const poll = setInterval(() => { if (cancelled()) finish(new Error('已停止文件回收')); }, 200);
      active = { finish, href: link.href };
      wc.session.on('will-download', receive);
      Promise.resolve().then(click).catch(error => finish(error));
    });
  }
  return { collect, permitsPopup: url => active?.href === url,
    close() { active?.finish(new Error('文件回收器已关闭')); wc.removeListener?.('did-create-window', childListener); } };
}

module.exports = { MAX_BYTES, validateArtifact, artifactPath, readArtifact, artifactLink, createArtifactCollector };
