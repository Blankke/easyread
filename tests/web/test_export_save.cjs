const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { registerExports } = require('../../electron/desktop-exports.cjs');

function nativeHandler(choice, trusted = true, directory = os.tmpdir()) {
  let handler;
  registerExports({
    ipcMain: {handle: (name, fn) => { if (name === 'easyread:save-export') handler = fn; }},
    app: {getPath: name => { assert.equal(name, 'downloads'); return directory; }},
    dialog: {showSaveDialog: async () => choice}, getWindow: () => null,
    trustedWindow: () => { if (!trusted) throw new Error('Untrusted IPC sender'); },
  });
  return handler;
}
const payload = {filename:'answer.md', data:Buffer.from('# Answer\n\nText').toString('base64')};

test('desktop default directory preserves existing exports and needs no picker', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'easyread-export-'));
  try {
    const handle = nativeHandler({canceled:true}, true, dir);
    await fs.writeFile(path.join(dir, payload.filename), 'existing note');
    assert.equal(await handle({}, {...payload, default:true}), true);
    assert.equal(await fs.readFile(path.join(dir, payload.filename), 'utf8'), 'existing note');
    assert.equal(await fs.readFile(path.join(dir, 'answer (1).md'), 'utf8'), '# Answer\n\nText');
  } finally { await fs.rm(dir, {recursive:true, force:true}); }
});

test('default directory IPC returns the actual path only to a trusted sender', async () => {
  const handlers = {};
  let trusted = true;
  registerExports({app:{getPath:() => 'C:\\Users\\Ed\\Downloads'}, ipcMain:{handle:(name, fn) => {handlers[name] = fn;}},
    trustedWindow:() => { if (!trusted) throw new Error('Untrusted'); }});
  assert.equal(handlers['easyread:export-directory']({}), 'C:\\Users\\Ed\\Downloads');
  trusted = false;
  assert.throws(() => handlers['easyread:export-directory']({}), /Untrusted/);
});

test('native export writes only to the user-selected path', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'easyread-export-'));
  const filePath = path.join(dir, 'chosen-name.md');
  try {
    assert.equal(await nativeHandler({filePath})({}, payload), true);
    assert.equal(await fs.readFile(filePath, 'utf8'), '# Answer\n\nText');
  } finally { await fs.rm(dir, {recursive:true, force:true}); }
});
test('native export cancellation does not write', async () => {
  assert.equal(await nativeHandler({canceled:true})({}, payload), false);
});
test('native export rejects untrusted senders and executable filenames', async () => {
  await assert.rejects(nativeHandler({}, false)({}, payload), /Untrusted/);
  await assert.rejects(nativeHandler({})({}, {...payload, filename:'answer.exe'}), /Unsupported/);
  await assert.rejects(nativeHandler({})({}, {...payload, data:'bad data'}), /Invalid/);
});

async function browserSave(extra = {}, runtime = {}) {
  const window = {PR:{t:s => s}, ...extra};
  window.parent = window;
  const context = {window, navigator:{userActivation:{isActive:true}}, Uint8Array, btoa, ...runtime};
  vm.runInNewContext(await fs.readFile(path.join(__dirname, '../../easyread/web/js/common/save-export.js'), 'utf8'), context);
  return Object.assign(window.PR.saveExport, {choose:window.PR.chooseExportFile, download:window.PR.downloadExport});
}
test('browser picker preserves the Markdown content and suggested filename', async () => {
  let selected, content, closed = false;
  const save = await browserSave({showSaveFilePicker:async options => {
    selected = options.suggestedName;
    return {createWritable:async () => ({write:async blob => {content = await blob.text();}, close:async () => {closed = true;}})};
  }});
  const destination = await save.choose('answer.md');
  assert.equal(await save(new Blob(['# Answer']), 'answer.md', destination), 'saved');
  assert.equal(selected, 'answer.md');
  assert.equal(content, '# Answer');
  assert.equal(closed, true);
});
test('canceling the browser picker does not trigger a download', async () => {
  const save = await browserSave({showSaveFilePicker:async () => {throw Object.assign(new Error('cancel'), {name:'AbortError'});}});
  assert.equal(await save.choose('answer.md'), false);
});
test('desktop bridge receives the exact UTF-8 contents', async () => {
  let received;
  const save = await browserSave({easyreadDesktop:{saveExport:async data => {received = data; return data.choose ? {path:'chosen.md', token:'choice'} : true;}}});
  const destination = await save.choose('answer.md');
  assert.equal(await save(new Blob(['# \u6211\u7684\u7b14\u8bb0']), 'answer.md', destination), 'saved');
  assert.equal(received.token, 'choice');
  assert.equal(Buffer.from(received.data, 'base64').toString('utf8'), '# \u6211\u7684\u7b14\u8bb0');
});
test('choosing a browser destination does not write until export is confirmed', async () => {
  let writes = 0;
  const save = await browserSave({showSaveFilePicker:async () => ({name:'chosen.md', createWritable:async () => ({write:async () => {writes++;}, close:async () => {}})})});
  const choice = await save.choose('answer.md');
  assert.equal(choice.name, 'chosen.md');
  assert.equal(writes, 0);
  assert.equal(await choice.save(new Blob(['# Answer'])), 'saved');
  assert.equal(writes, 1);
});
test('native destination token is required and is consumed after saving', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'easyread-export-'));
  const filePath = path.join(dir, 'chosen.md');
  try {
    const handle = nativeHandler({filePath});
    const choice = await handle({}, {filename:'answer.md', choose:true});
    assert.equal(choice.path, filePath);
    await assert.rejects(fs.readFile(filePath), {code:'ENOENT'});
    await assert.rejects(handle({}, {...payload, token:'forged'}), /Choose/);
    await assert.rejects(handle({}, {...payload, filename:'other.md', token:choice.token}), /Choose/);
    assert.equal(await handle({}, {...payload, token:choice.token}), true);
    await assert.rejects(handle({}, {...payload, token:choice.token}), /Choose/);
  } finally { await fs.rm(dir, {recursive:true, force:true}); }
});
test('default download uses the existing browser download destination without a picker', async () => {
  let clicked = false, downloaded;
  const anchor = {click:() => {clicked = true;}, remove:() => {}};
  const unexpectedPicker = () => {throw new Error('Default export must not open a picker');};
  const save = await browserSave({showSaveFilePicker:unexpectedPicker, easyreadDesktop:{saveExport:unexpectedPicker}}, {
    URL:{createObjectURL:blob => {downloaded = blob; return 'blob:test';}, revokeObjectURL:() => {}},
    document:{createElement:() => anchor, body:{append:() => {}}}, setTimeout:fn => fn(),
  });
  assert.equal(await save(new Blob(['# Notes']), 'notes.md'), 'download');
  assert.equal(clicked, true);
  assert.equal(anchor.download, 'notes.md');
  assert.equal(await downloaded.text(), '# Notes');
});
for (const kind of ['notes', 'answer']) test(`${kind}: default export, canceled picker, explicit destination and reopened default`, async () => {
  let handler, result, closed = false, cancelChoice = true;
  const box = {innerHTML:''}, location = {}, name = {}, go = {disabled:false}, pick = {disabled:false};
  const elements = {'.dialog':box, '[data-export-dialog]':box, '[data-export-location]':location, '[data-export-name]':name};
  const dlg = {querySelector:selector => elements[selector], querySelectorAll:() => [pick, go],
    classList:{add:() => {}, remove:() => {closed = true;}}, addEventListener:(_, fn) => {handler = fn;}};
  const PR = {state:{paper:{meta:{short_zh:'Paper'}}, reader:{}, discussion:{}}, t:s => s, esc:s => s,
    $:() => dlg, $$:() => [], myNotes:() => [], ls:{get:(_, fallback) => fallback, set:() => {}},
    exportDirectory:async () => 'Browser download folder', canChooseExportFile:() => true, chooseExportFile:async () => cancelChoice ? false : ({name:'chosen.md', save:async blob => {result = ['chosen', await blob.text()]; return 'saved';}}),
    notesMarkdown:() => '# Notes', toast:() => {}, downloadExport:async blob => {result = ['default', await blob.text()]; return 'download';},
    api:async () => ({data:Buffer.from('# Answer').toString('base64'), mime:'text/markdown', filename:'answer.md'})};
  const context = {window:{PR}, Blob, Uint8Array, atob};
  for (const file of ['common/export-dialog.js', 'reader/export.js', 'reader/chat-export.js']) {
    vm.runInNewContext(await fs.readFile(path.join(__dirname, '../../easyread/web/js', file), 'utf8'), context);
  }
  PR.saveExport = (blob, filename, destination) => destination ? destination.save(blob) : PR.downloadExport(blob);
  const open = () => kind === 'notes' ? PR.openExport() : PR.exportChatMarkdown('thread', 'answer', {disabled:false});
  const click = action => handler({target:{closest:selector => selector === `[data-export-${action}]` ? (action === 'pick' ? pick : go) : null}});
  const expected = kind === 'notes' ? '# Notes' : '# Answer';
  await open();
  assert.match(box.innerHTML, /data-export-location/);
  assert.doesNotMatch(box.innerHTML, /data-export-go disabled/);
  assert.equal(result, undefined);
  await click('pick');
  await click('go');
  assert.deepEqual(result, ['default', expected]);
  await open();
  result = undefined;
  cancelChoice = false;
  await click('pick');
  assert.equal(location.value, 'chosen.md');
  assert.equal(name.value, 'chosen.md');
  assert.equal(result, undefined);
  cancelChoice = true;
  await click('pick');
  await click('go');
  assert.deepEqual(result, ['chosen', expected]);
  assert.equal(closed, true);
  await open();
  await click('go');
  assert.deepEqual(result, ['default', expected]);
});
