const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function setup() {
  const events = {}, requests = [], box = { innerHTML: "" };
  const classes = new Set();
  const dlg = {
    querySelector: () => box,
    classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) },
    addEventListener: (name, fn) => { events[name] = fn; },
  };
  const PR = {
    $: () => dlg, lib: { load() {}, useServerSide() {} }, esc: String,
    t: (text, vars = {}) => text.replace(/\{(\w+)\}/g, (_, key) => vars[key]),
    pickFolder: async () => "/papers", loadPrefs: async () => ({}), toast() {},
    api: async (url, options) => {
      requests.push([url, options]);
      if (url.endsWith("/scan")) return { path: "/papers", with_pdf: 2, collections: 1 };
      return { state: "idle" };
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../easyread/web/js/library/bulk-import.js"), "utf8"),
    { window: { PR }, setTimeout: () => 0, clearTimeout() {} });
  const flush = async () => { for (let n = 0; n < 10; n++) await Promise.resolve(); };
  const click = async action => { await events.click({ target: { closest: () => ({ dataset: { z: action } }) } }); await flush(); };
  const change = (name, checked) => events.change({ target: { dataset: { zo: name }, checked } });
  return { PR, requests, box, change, click, flush };
}

test("bulk folder import copies by default and submits the selected link option", async () => {
  const p = setup();
  await p.PR.openFolderImport(); await p.flush();
  assert.match(p.box.innerHTML, /data-zo="link"[^>]*>/);
  assert.doesNotMatch(p.box.innerHTML, /data-zo="link" checked/);
  p.change("fetch", true);
  p.change("link", true);
  assert.match(p.box.innerHTML, /data-zo="link" checked/);
  await p.click("start");
  const [, options] = p.requests.find(([url]) => url.endsWith("/start"));
  assert.equal(options.body.link, true);
  assert.equal(options.body.fetch, false);
  assert.equal(options.body.source, "folder");
});
