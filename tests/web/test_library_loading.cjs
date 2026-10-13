const assert = require("node:assert/strict");
const { test } = require("node:test");
const { page, deferred } = require("../helpers/library_page.cjs");

const paper = (title = "Existing long article") => ({ id: "longpaper", title_en: title, tags: ["分类"], status: "reading", added: "2026-10-04" });
const data = (items = [paper()]) => ({ items, engine: "none", token: "live-token", first_run: false, version: "1.3.1" });
const welcome = p => p.node("#list").innerHTML.includes('class="welcome"');

test("unreadable paper stays visible without hiding healthy papers or showing offline", async () => {
  const broken = { id: "broken000001", title_en: "broken000001", tags: [], load_error: "damaged reader.json" };
  const p = page().library([paper(), broken]);
  await p.boot();
  assert.equal(p.PR.lib.loadStatus, "ready");
  assert.match(p.node("#list").innerHTML, /Existing long article/);
  assert.match(p.node("#list").innerHTML, /broken000001/);
  assert.match(p.node("#list").innerHTML, /数据文件无法读取/);
  assert.doesNotMatch(p.node("#list").innerHTML, /连不上本地服务/);
});

test("idle polling keeps loaded rows in place without an updating banner", async () => {
  const p = page().library([paper()]); await p.boot();
  const pending = deferred(), row = p.rows[0], html = p.node("#list").innerHTML;
  p.node(".main").scrollTop = 420;
  p.setLibraryRead(() => pending.promise);
  await p.advance(15000);
  assert.equal(p.requests.length, 2);
  assert.equal(p.PR.lib.loadStatus, "ready");
  assert.equal(p.node("#list").innerHTML, html);
  assert.equal(p.rows[0], row);
  pending.resolve({ ...p.PR.lib.lastData, token: "renewed-token" }); await p.flush();
  assert.equal(p.rows[0], row);
  assert.equal(p.node(".main").scrollTop, 420);
  assert.equal(p.PR.token, "renewed-token");
});

test("busy polling updates changed progress without showing a library-loading banner", async () => {
  const running = { ...paper(), job: { state: "running", done: 1, total: 4 } };
  const p = page().library([running]); await p.boot();
  const pending = deferred(); p.setLibraryRead(() => pending.promise);
  await p.advance(2500);
  assert.doesNotMatch(p.node("#list").innerHTML, /正在更新文献库/);
  pending.resolve(data([{ ...running, job: { ...running.job, done: 2 } }])); await p.flush();
  assert.match(p.node("#list").innerHTML, /2\/4 页/);
  assert.doesNotMatch(p.node("#list").innerHTML, /正在更新文献库/);
});

test("retrying after a failed poll shows loading instead of the stale error", async () => {
  const retry = deferred(), p = page().library([paper()]); await p.boot();
  p.setLibraryRead(() => Promise.reject(new Error("offline")));
  await p.advance(15000);
  assert.match(p.node("#list").innerHTML, /连不上本地服务/);
  p.setLibraryRead(() => retry.promise);
  await p.advance(1500);
  assert.equal(p.PR.lib.loadStatus, "loading");
  assert.match(p.node("#list").innerHTML, /正在更新文献库/);
  assert.doesNotMatch(p.node("#list").innerHTML, /连不上本地服务/);
  retry.resolve(data()); await p.flush();
  assert.equal(p.PR.lib.loadStatus, "ready");
  assert.doesNotMatch(p.node("#list").innerHTML, /up-status/);
});

test("prefs arriving before library data never show first-time setup", async () => {
  const library = deferred(), prefs = deferred(), p = page().library([]);
  p.PR.loadPrefs = () => prefs.promise;
  p.setLibraryRead(() => library.promise);
  await p.boot();
  assert.match(p.node("#list").innerHTML, /正在加载文献库/);
  prefs.resolve({ library: { cats: ["分类"] } }); await p.flush();
  assert.equal(welcome(p), false);
  assert.equal(p.PR.lib.loadStatus, "loading");
  library.resolve(data()); await p.flush();
  assert.match(p.node("#list").innerHTML, /Existing long article/);
  assert.equal(p.PR.lib.loadStatus, "ready");
});

test("welcome requires a valid empty live response, even when first_run is false", async () => {
  const pending = deferred(), p = page().library([]);
  p.setLibraryRead(() => pending.promise); await p.boot();
  assert.equal(welcome(p), false);
  pending.resolve(data([])); await p.flush();
  assert.equal(welcome(p), true);
  assert.equal(p.PR.lib.loadStatus, "ready");
});

test("a slow reader has its return context immediately and fresh return keeps cached rows", async () => {
  const p = page().library([paper()]); await p.boot();
  p.PR.lib.tag = "分类"; p.PR.lib.openReader("longpaper");
  const article = deferred(), reader = page(p.location.href, p.storage).reader(() => article.promise);
  const back = reader.node("#backBtn").href;
  assert.match(back, /^\/\?library=/);  // No await of the article state is needed.
  assert.equal(reader.node("#backBtn").title, "返回“分类”");
  const live = deferred(), returned = page("http://127.0.0.1:8765" + back, p.storage).library([]);
  returned.setLibraryRead(() => live.promise); await returned.boot();
  assert.match(returned.node("#list").innerHTML, /Existing long article/);
  assert.match(returned.node("#list").innerHTML, /正在更新文献库/);
  assert.equal(returned.PR.lib.tag, "分类");
  assert.equal(returned.PR.lib.selected, "longpaper");
  assert.equal(returned.PR.token, undefined);  // Cache must never restore a server write token.
  assert.equal(welcome(returned), false);
  assert.equal(p.storage.get("easyread-library-list").includes("live-token"), false);
  live.resolve(data([paper("Updated article")])); await returned.flush();
  assert.match(returned.node("#list").innerHTML, /Updated article/);
  assert.equal(returned.PR.token, "live-token");
  article.reject(new Error("article failed")); await reader.flush();
  assert.match(reader.node("#paper").innerHTML, /\?library=/);
});

test("cached browser-history return retains its existing list on a failed refresh", async () => {
  const p = page().library([paper()]); await p.boot();
  p.PR.lib.openReader("longpaper"); p.location.href = "http://127.0.0.1:8765/";
  p.setLibraryRead(() => Promise.reject(new Error("temporarily offline")));
  await p.cachedBack();
  assert.equal(p.PR.lib.loadStatus, "error");
  assert.match(p.node("#list").innerHTML, /Existing long article/);
  assert.match(p.node("#list").innerHTML, /temporarily offline/);
  assert.equal(welcome(p), false);
});

test("a live response does not undo a new filter chosen on the cached return list", async () => {
  const p = page().library([paper()]); await p.boot();
  p.PR.lib.tag = "分类"; p.PR.lib.openReader("longpaper");
  const reader = page(p.location.href, p.storage); reader.PR.libraryNav.readerBack("longpaper");
  const live = deferred(), returned = page("http://127.0.0.1:8765" + reader.node("#backBtn").href, p.storage).library([]);
  returned.setLibraryRead(() => live.promise); await returned.boot();
  returned.node("#q").value = "new filter";
  returned.node("#q").input({ target: returned.node("#q") });
  live.resolve(data()); await returned.flush();
  assert.equal(returned.PR.lib.q, "new filter");
  assert.equal(returned.node("#q").value, "new filter");
});

test("initial failure is distinct from empty and automatically retries successfully", async () => {
  const retry = deferred(), p = page().library([]);
  p.setLibraryRead((options, attempt) => attempt === 1 ? Promise.reject(new Error("offline")) : retry.promise);
  await p.boot();
  assert.equal(p.PR.lib.loadStatus, "error");
  assert.match(p.node("#list").innerHTML, /data-library-retry/);
  assert.equal(welcome(p), false);
  await p.advance(1499); assert.equal(p.requests.length, 1);
  await p.advance(1); assert.equal(p.requests.length, 2);
  retry.resolve(data()); await p.flush();
  assert.equal(p.PR.lib.loadStatus, "ready");
  assert.match(p.node("#list").innerHTML, /Existing long article/);
});

test("a timed-out request is aborted and its late empty response cannot replace a retry", async () => {
  const slow = deferred(), retry = deferred(), p = page().library([]);
  p.setLibraryRead((options, attempt) => attempt === 1 ? slow.promise : retry.promise);
  await p.boot();
  await p.advance(10000);
  assert.equal(p.requests[0].options.signal.aborted, true);
  assert.equal(p.PR.lib.loadStatus, "error");
  assert.match(p.node("#list").innerHTML, /文献库加载超时/);
  assert.doesNotMatch(p.node("#list").innerHTML, /连不上本地服务/);
  assert.equal(welcome(p), false);
  await p.advance(1500);
  retry.resolve(data()); await p.flush();
  slow.resolve(data([])); await p.flush();
  assert.equal(p.PR.lib.loadStatus, "ready");
  assert.match(p.node("#list").innerHTML, /Existing long article/);
  assert.equal(welcome(p), false);
});

test("out-of-order refresh results cannot clobber the newest successful list", async () => {
  const first = deferred(), second = deferred(), p = page().library([]);
  p.setLibraryRead((options, attempt) => attempt === 1 ? first.promise : second.promise);
  await p.boot();
  const latestLoad = p.PR.lib.load(); await p.flush();
  assert.equal(p.requests[0].options.signal.aborted, true);
  second.resolve(data([paper("Newest list")])); await latestLoad; await p.flush();
  first.resolve(data([])); await p.flush();
  assert.match(p.node("#list").innerHTML, /Newest list/);
  assert.equal(welcome(p), false);
});

test("incomplete responses and synchronous read failures never count as an empty library", async () => {
  for (const result of [{}, { items: [null] }, "throw"]) {
    const p = page().library([]);
    p.setLibraryRead(() => { if (result === "throw") throw new Error("read failed"); return result; });
    await p.boot();
    assert.equal(p.PR.lib.loadStatus, "error");
    assert.equal(welcome(p), false);
    const html = p.node("#list").innerHTML;
    assert.match(html, result === "throw" ? /连不上本地服务/ : /文献库加载失败/);
    if (result !== "throw") assert.doesNotMatch(html, /连不上本地服务/);
  }
});

test("manual retry clears the scheduled retry and does not duplicate requests", async () => {
  const p = page().library([]), retry = deferred();
  p.setLibraryRead((options, attempt) => attempt === 1 ? Promise.reject(new Error("offline")) : retry.promise);
  await p.boot();
  p.node("#list").click({ target: { closest: selector => selector === "[data-library-retry]" ? {} : null } });
  await p.flush();
  assert.equal(p.requests.length, 2);
  await p.advance(1500); assert.equal(p.requests.length, 2);
  retry.resolve(data()); await p.flush();
  assert.equal(p.PR.lib.loadStatus, "ready");
});

test("a hung preferences request cannot hold up a successful library request", async () => {
  const p = page().library([paper()]), prefs = deferred();
  p.PR.loadPrefs = () => prefs.promise;
  await p.boot();
  assert.equal(p.PR.lib.loadStatus, "ready");
  assert.match(p.node("#list").innerHTML, /Existing long article/);
});

test("return cache rejects stale, corrupted and invalid records", async () => {
  const p = page().library([paper()]); await p.boot(); p.PR.lib.openReader("longpaper");
  const reader = page(p.location.href, p.storage); reader.PR.libraryNav.readerBack("longpaper");
  const home = page("http://127.0.0.1:8765" + reader.node("#backBtn").href, p.storage);
  const original = p.storage.get("easyread-library-list");
  assert.ok(home.PR.libraryNav.cachedList());
  for (const invalid of ["{broken", JSON.stringify({ version: 1, t: Date.now() - 31 * 60000, data: data() }),
    JSON.stringify({ version: 1, t: Date.now(), data: data([{ id: "../bad", tags: [] }]) })]) {
    p.storage.set("easyread-library-list", invalid);
    assert.equal(home.PR.libraryNav.cachedList(), null);
  }
  p.storage.set("easyread-library-list", original);
  assert.equal(page("http://127.0.0.1:8765/", p.storage).PR.libraryNav.cachedList(), null);
});
