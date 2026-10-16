/*
 * 用法：网页执行器在进入论文会话前调用 syncGlossary；默认关闭项目文件同步。
 * 测试：node --test tests/desktop/test_chatgpt_resources.cjs。
 * 每个项目只有一个逻辑术语库，论文译法按论文和目标语言分组，当前论文术语优先。
 */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { atomicJSON } = require('./chatgpt-sessions.cjs');
const hash = text => createHash('sha256').update(text).digest('hex');

function buildGlossary(sources) {
  const papers = [];
  for (const [paperKey, root] of Object.entries(sources).sort(([a], [b]) => a.localeCompare(b))) {
    const file = path.join(root, 'paper.json');
    if (!fs.existsSync(file)) continue;
    const paper = JSON.parse(fs.readFileSync(file, 'utf8'));
    const terms = (paper.glossary || []).filter(x => x && typeof x.en === 'string' && typeof x.zh === 'string');
    if (!terms.length) continue;
    papers.push({ paper_id: path.basename(root), source_sha256: paper.meta?.source_sha256 || '',
      target: paper.meta?.target || 'zh', glossary: terms });
  }
  return JSON.stringify({ schema: 1, authority: '当前任务论文术语表优先；其他论文译法仅供参考，不能作为事实依据。', papers });
}

async function syncResource(index, slot, desired, adapter, persist, limit = 5) {
  const old = index.entries[slot];
  // 每次重启/同步都从可见文件列表核对，不能仅凭本地 confirmed 跳过。
  let remote = await adapter.list();
  const present = entry => remote.filter(x => x.id === entry.remote_id && x.name === entry.remote_name).length === 1;
  const same = old?.content_hash === desired.content_hash && present(old) &&
    !remote.find(x => x.id === old.remote_id).busy;
  if (!same) {
    if (remote.some(x => x.name === desired.remote_name)) throw new Error('项目存在无法确认归属的同名资料，已改用会话附件');
    if (remote.length >= limit) throw new Error('项目文件数量达到配置上限，已改用会话附件');
    // 发起前写 intent，崩溃后同名项会触发人工核对，不自动重复上传。
    index.pending = { slot, ...desired, status: 'uploading' };
    persist();
    await adapter.upload(desired.path, desired.remote_name);
    remote = await adapter.list();
    const matches = remote.filter(x => x.name === desired.remote_name);
    if (matches.length !== 1 || !matches[0].id || matches[0].busy) throw new Error('项目资料未确认上传完成');
    if (old) index.retired.push(old);
    index.entries[slot] = { ...desired, remote_id: matches[0].id, status: 'confirmed', updated_at: new Date().toISOString() };
    delete index.pending;
    persist();
  }
  // 仅删本地已确认由 EasyRead 上传且被新版本替代的精确 ID；任何用户资料不在清理范围内。
  for (const entry of [...index.retired]) {
    remote = await adapter.list();
    if (present(entry)) {
      await adapter.remove(entry.remote_id, entry.remote_name);
      remote = await adapter.list();
      if (present(entry)) throw new Error('旧项目资料仍在使用或删除未确认');
    }
    index.retired = index.retired.filter(x => x !== entry);
    persist();
  }
  return index.entries[slot];
}

async function syncGlossary({ userData, account, projectURL, cwd, adapter, limit }) {
  const scope = hash(account + projectURL);
  const dir = path.join(userData, 'chatgpt-resources', scope);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'index.json');
  let index = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) :
    { schema: 1, account, project_url: projectURL, sources: {}, entries: {}, retired: [] };
  const persist = () => atomicJSON(file, index);
  index.sources[hash(cwd)] = cwd;
  try {
    const content = buildGlossary(index.sources);
    const content_hash = hash(content);
    const remote_name = `EasyRead-glossary-${content_hash}.json`;
    const local = path.join(dir, remote_name);
    if (!fs.existsSync(local)) fs.writeFileSync(local, content, { flag: 'wx', mode: 0o600 });
    await syncResource(index, 'glossary', { kind: 'glossary', content_hash, remote_name, path: local }, adapter, persist, limit);
    index.status = 'confirmed';
    index.error = '';
  } catch (error) {
    index.status = 'fallback';
    index.error = error.message;
  }
  persist();
  return { status: index.status, error: index.error };
}

// 按来源标签与 aria-controls 定位面板，兼容网站仍使用资料弹层的布局。
function projectFilesPage(action, value = {}) {
  try {
    const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const label = el => (el.getAttribute('aria-label') || el.innerText || el.textContent || '').trim();
    const find = (root, re) => [...root.querySelectorAll('button,[role="button"],[role="menuitem"],[role="tab"]')]
      .filter(visible).find(el => re.test(label(el)));
    const dialog = [...document.querySelectorAll('[role="dialog"],dialog')].find(visible);
    const tab = [...document.querySelectorAll('[role="tab"]')].filter(visible)
      .find(el => /^(来源|项目来源|sources)(\s*\(?\d+\)?)?$/i.test(label(el)));
    const panel = tab && document.getElementById(tab.getAttribute('aria-controls'));
    const retry = message => ({ error: message, retryable: true });
    if (action === 'open') {
      if (tab) {
        if (tab.getAttribute('aria-selected') !== 'true') tab.click();
        return true;
      }
      const button = find(document.querySelector('main') || document, /^(项目文件|项目来源|来源|project files|project sources|sources|添加文件|add files|添加来源|add sources)(\s*\(?\d+\)?)?$/i);
      if (!button) return retry('项目资料入口尚未加载');
      button.click();
      return true;
    }
    if (action === 'confirm-remove') {
      if (!dialog || !dialog.textContent.includes(value.name)) return false;
      const button = find(dialog, /^(delete|remove|删除|移除)$/i);
      if (button) button.click();
      return !!button;
    }
    const root = panel && visible(panel) && tab.getAttribute('aria-selected') === 'true' ? panel : dialog;
    if (!root) return retry('项目资料面板尚未加载');
    const errors = [...root.querySelectorAll('[role="alert"]')].filter(visible).map(label);
    if (errors.length) throw new Error('项目上传失败或配额受限：' + errors.join(' ').slice(0, 180));
    if ([...root.querySelectorAll('[role="status"]')].some(el => /加载|loading/i.test(label(el))))
      return retry('项目资料列表正在加载');
    const legacy = [...root.querySelectorAll('[data-file-id]')].filter(visible);
    const rows = legacy.length ? legacy : [...root.querySelectorAll('li')].filter(visible);
    const entries = rows.map(row => {
      const name = row.querySelector('[data-testid="file-name"]')?.textContent?.trim() ||
        row.getAttribute('data-file-name') || row.querySelector('[title]')?.getAttribute('title') || '';
      const created = row.querySelector('time[datetime]')?.getAttribute('datetime');
      // 新版不暴露服务端文件 ID；精确名称加上传时间组成可复核标识，名称相同仍不能互相冒充。
      const id = row.getAttribute('data-file-id') || (name && created && !Number.isNaN(Date.parse(created)) ?
        JSON.stringify(['source', name, created]) : '');
      return { id, name, busy: row.getAttribute('aria-busy') === 'true' || !!row.querySelector('[aria-busy="true"],[role="progressbar"]') };
    });
    const identified = root === panel || /项目文件|项目来源|project files|project sources|添加来源|add sources/i.test(root.textContent || '');
    if (!identified || entries.some(x => !x.id || !x.name) || new Set(entries.map(x => x.id)).size !== entries.length)
      throw new Error('当前网页未提供可核实的项目文件列表和唯一标识');
    const empty = /暂无文件|尚未添加|no files|no sources/i.test(root.textContent || '') ||
      root === panel && !![...root.querySelectorAll('h3')].find(el => /^(为 ChatGPT 提供更多上下文|Give ChatGPT more context)$/i.test(label(el)));
    if (!entries.length && !empty)
      return retry('项目文件列表尚未确认完整加载');
    if (action === 'list') return entries;
    if (action === 'input') {
      const inputs = [...root.querySelectorAll('input[type="file"]')].filter(el => !el.disabled);
      if (inputs.length !== 1) throw new Error('项目文件上传控件不唯一');
      inputs[0].setAttribute('data-easyread-project-upload', 'true');
      return true;
    }
    if (action === 'remove') {
      const entry = entries.find(x => x.id === value.id && x.name === value.name);
      const row = rows[entries.indexOf(entry)];
      if (!entry) throw new Error('无法安全定位旧项目资料的删除按钮');
      let button = find(row, /^(delete|remove|删除|移除)( file|文件)?$/i);
      if (!button) {
        const menu = [...row.querySelectorAll('button[aria-haspopup="menu"]')].filter(visible);
        if (menu.length !== 1) throw new Error('旧项目资料操作菜单不唯一');
        if (menu[0].getAttribute('aria-expanded') !== 'true') {
          menu[0].click();
          return retry('正在打开旧项目资料操作菜单');
        }
        const popup = [...document.querySelectorAll('[role="menu"]')].find(visible);
        button = popup && find(popup, /^(delete|remove|删除|移除|从项目中移除|从项目移除)( file|文件|来源| source| from project)?$/i);
        if (!button) return retry('旧项目资料菜单尚未加载');
      }
      button.click();
      return true;
    }
    throw new Error('未知项目资料操作');
  } catch (error) { return { error: error.message }; }
}

module.exports = { buildGlossary, syncResource, syncGlossary, projectFilesPage };
