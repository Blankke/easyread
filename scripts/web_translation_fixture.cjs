/*
 * 用法：由 verify_web_translation.cjs --fixture file 4 调用 createFixture。
 * 生成可复现的合成 PDF 和隔离文献库，保存在 outputs/web-translation/，不复制用户配置或凭据。
 * 用于真实网页交付与页码完整性验证；合成页面不能代表复杂论文的语义准确率。
 */
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function fixturePDF(count) {
  const objects = [];
  const add = value => { objects.push(value); return objects.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pages = [];
  for (let n = 1; n <= count; n++) {
    const lines = [`EasyRead transport verification - Section ${n}`,
      `This is page ${n} of a synthetic document with ${count} pages.`,
      `The sample contains ${n * 10} observations measured in seconds.`,
      'The treatment may reduce latency; this does not establish causality.',
      'The baseline and treatment must use the same input distribution.',
      `The equation for this page is y = ${n}x + 1.`,
      'Table: Method / Time in seconds', `Baseline / ${n * 2}`, `Treatment / ${n}`,
      'Figure: Input -> Model -> Output',
      'The arrow indicates processing order, not a statistical relationship.',
      'All conclusions in this synthetic example are limited to this page.'];
    const stream = 'BT /F1 12 Tf 50 750 Td 22 TL\n' + lines.map((s, i) =>
      `${i ? 'T* ' : ''}(${s.replace(/[\\()]/g, '\\$&')}) Tj`).join('\n') + '\nET';
    const content = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    pages.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[1] = `<< /Type /Pages /Count ${count} /Kids [${pages.map(id => `${id} 0 R`).join(' ')}] >>`;
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((obj, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.from(pdf + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`);
}

function createFixture(root, mode, pages, model, options = {}) {
  if (!['text', 'file', 'auto'].includes(mode) || !Number.isInteger(pages) || pages < 1 || pages > 12)
    throw new Error('合成验证用法：--fixture text|file|auto 1-12');
  const parent = path.join(root, 'outputs', 'web-translation');
  fs.mkdirSync(parent, { recursive: true });
  const home = fs.mkdtempSync(path.join(parent, `${mode}-${pages}-`));
  const pid = 'transport-fixture', library = path.join(home, 'library'), paper = path.join(library, pid);
  fs.mkdirSync(paper, { recursive: true });
  const pdf = fixturePDF(pages);
  fs.writeFileSync(path.join(paper, 'source.pdf'), pdf);
  const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2));
  write(path.join(paper, 'paper.json'), { schema: 2,
    meta: { title_en: 'EasyRead synthetic transport verification', pdf: 'source.pdf', target: 'zh',
      source_sha256: createHash('sha256').update(pdf).digest('hex') },
    blocks: [], references: [], glossary: [{ en: 'latency', zh: '延迟' }], translation: { done_pages: [] } });
  write(path.join(paper, 'item.json'), { added: new Date().toISOString(), status: 'unread' });
  write(path.join(home, 'config.json'), { engine: 'chatgpt_web', library_dir: library, auto_translate: false,
    check_updates: false, chatgpt_web: { model, output_mode: mode, batch_pages: 4, file_batch_pages: pages, ...options } });
  return { home, pid, paper };
}
module.exports = { createFixture, fixturePDF };
