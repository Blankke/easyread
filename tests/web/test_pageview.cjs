// 用法：node --test tests/web/test_pageview.cjs；验证原页定位、联动与局部缩放。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

function reader(mode = "server") {
  const nodes = new Map();
  const events = new Map();
  const documentEvents = new Map();
  const scrolls = [];
  function node(selector) {
    if ([".pv-page", ".pv-page img", ".pv-hl"].includes(selector) && nodes.get(".pv-scroll")?.children.length) {
      const label = nodes.get(".pv-label")?.textContent || "1";
      const n = Number(label.match(/\d+/)[0]) - 1;
      const page = nodes.get(".pv-scroll").children[n];
      return selector === ".pv-page" ? page : page.children[selector === ".pv-hl" ? 1 : 0];
    }
    if (!nodes.has(selector)) nodes.set(selector, {
      classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
      dataset: {}, scrollTop: 0, scrollLeft: 0, listeners: {}, listenerOptions: {}, children: [],
      style: { setProperty(name, value) { this[name] = value; } },
      checked: true, complete: true, clientWidth: 480, clientHeight: 480, offsetHeight: 1000,
      addEventListener(name, fn, options) { this.listeners[name] = fn; this.listenerOptions[name] = options; },
      replaceChildren(...children) { this.children = children; },
      scrollTo(value) { this.scroll = value; },
      getBoundingClientRect() {
        const scroller = node(".pv-scroll");
        const size = this.dataset.n ? 1000 * (parseFloat(scroller.style["--pv-page-width"]) || 100) / 100 : 1000;
        const top = this.dataset.n ? 18 + (Number(this.dataset.n) - 1) * (size + 18) - scroller.scrollTop : 0;
        return { left: this.dataset.n ? -scroller.scrollLeft : 0, top, bottom: top + size, width: size, height: size };
      },
      getAttribute(name) { return this[name] || null; }, setAttribute(name, value) { this[name] = value; },
    });
    return nodes.get(selector);
  }
  let reading = "head", selected = null;
  const PR = {
    t: (s, v) => (v ? s.replace(/\{(\w+)\}/g, (m, k) => v[k]) : s),
    state: { paper: { meta: { pages: [{ img: "pages/one.webp" }, { img: "pages/two.webp" }] } }, layout: {} },
    $: node, on(name, fn) { events.set(name, fn); }, store: { mode }, imageUrl: img => "/p/paper/" + img,
    pdfUrl: page => "/p/paper/source.pdf#page=" + page,
    readingBlock: () => reading, currentBlock: () => selected,
    blockById: { first: { page: 1 }, second: { page: 2 } },
    jumpTo(id) { this.jumped = id; },
    fitWide() {}, renderMargin() {},
  };
  const sandbox = {
    window: { PR, scrollY: 0, innerHeight: 800, scrollTo: value => scrolls.push(value) }, document: { body: node("body"), addEventListener: (name, fn) => documentEvents.set(name, fn), getElementById: id => nodes.get(id) || null, createElement: () => node("created-" + nodes.size) },
    devicePixelRatio: 1, Image: class {}, setTimeout: () => 1, clearTimeout() {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../easyread/web/js/reader/page-zoom.js"), "utf8"), sandbox);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../../easyread/web/js/reader/pageview.js"), "utf8"), sandbox);
  return { PR, node, events, documentEvents, scrolls, read: id => { reading = id; }, select: id => { selected = id; } };
}

test("opening original pages at the paper title loads the first image", () => {
  const r = reader();
  r.PR.togglePages(true);
  assert.equal(r.node(".pv-page img").src, "/p/paper/pages/one.webp?w=1000");
  assert.equal(r.node(".pv-label").textContent, "第 1 / 2 页");
});

test("scrolling follows the reading position after another block was selected", () => {
  const r = reader();
  r.select("second"); r.read("second"); r.PR.togglePages(true);
  assert.equal(r.node(".pv-page img").src, "/p/paper/pages/two.webp?w=1000");
  r.read("first"); r.PR.syncPage(false);
  assert.equal(r.node(".pv-page img").src, "/p/paper/pages/one.webp?w=1000");
});

test("turning off follow retains the manually selected original page", () => {
  const r = reader();
  r.select("second"); r.PR.togglePages(true);
  r.node(".pv-follow input").checked = false;
  r.read("first"); r.PR.syncPage(false);
  assert.equal(r.node(".pv-page img").src, "/p/paper/pages/two.webp?w=1000");
});

test("reenabling follow immediately resumes at the viewport instead of a stale selection", () => {
  const r = reader();
  r.select("second"); r.read("first"); r.PR.togglePages(true);
  const follow = r.node(".pv-follow input"), scroller = r.node(".pv-scroll");
  follow.checked = false;
  scroller.listeners.pointerdown();
  scroller.scrollTop = 1018; scroller.listeners.scroll();
  assert.equal(r.node(".pv-label").textContent, "第 2 / 2 页");
  follow.checked = true;
  follow.listeners.change?.();
  assert.equal(r.node(".pv-label").textContent, "第 1 / 2 页");
  r.read("second"); r.PR.syncPage(false);
  assert.equal(r.node(".pv-label").textContent, "第 2 / 2 页");
});

const crossing = () => ({ page: 1, box: [0.08, 0.10, 0.92, 0.90], boxes: [[0.08, 0.60, 0.48, 0.90], [0.52, 0.10, 0.92, 0.30]] });

// 模拟可取消的滚轮事件，直接验证浏览器默认缩放是否被拦截。
function wheel(scroller, values = {}) {
  const event = {
    ctrlKey: true, deltaY: -100, deltaMode: 0, clientX: 200, clientY: 240,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; }, ...values,
  };
  scroller.listeners.wheel(event);
  return event;
}

test("Ctrl wheel zooms only original pages around the pointer without moving the translation", () => {
  const r = reader();
  r.node("b-first"); r.node("b-second");
  r.PR.togglePages(true);
  const scroller = r.node(".pv-scroll");
  scroller.scrollTop = 1018;
  scroller.scrollLeft = 60;
  const before = scroller.children[1].getBoundingClientRect();
  const event = wheel(scroller);
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  assert.equal(scroller.listenerOptions.wheel.passive, false);
  assert.ok(parseFloat(scroller.style["--pv-page-width"]) > 100);
  assert.equal(scroller.clientWidth, 480);
  assert.equal(scroller.clientHeight, 480);
  // 应用滚动结果后，同一页的同一相对坐标仍在鼠标下面，前页高度变化也得到补偿。
  scroller.scrollTop = scroller.scroll.top;
  scroller.scrollLeft = scroller.scroll.left;
  const after = scroller.children[1].getBoundingClientRect();
  assert.ok(Math.abs((event.clientX - before.left) / before.width - (event.clientX - after.left) / after.width) < 1e-9);
  assert.ok(Math.abs((event.clientY - before.top) / before.height - (event.clientY - after.top) / after.height) < 1e-9);
  scroller.listeners.scroll();
  assert.equal(r.scrolls.length, 0);
  const position = scroller.scroll;
  r.read("first"); r.PR.syncPage(false);
  assert.equal(scroller.scroll, position);
});

test("ordinary wheel retains native scrolling and bidirectional follow", () => {
  const r = reader();
  r.node("b-first");
  r.PR.togglePages(true);
  const scroller = r.node(".pv-scroll");
  const event = wheel(scroller, { ctrlKey: false });
  assert.equal(event.prevented, undefined);
  assert.equal(scroller.style["--pv-page-width"], undefined);
  scroller.listeners.scroll();
  assert.equal(r.scrolls.length, 1);
});

test("zoom is bounded, requests sharper images, and persists across page changes", () => {
  for (const mode of ["server", "static"]) {
    const r = reader(mode);
    r.PR.togglePages(true);
    const scroller = r.node(".pv-scroll");
    for (let i = 0; i < 20; i++) wheel(scroller, { deltaMode: 1 });
    assert.equal(scroller.style["--pv-page-width"], "400%");
    assert.equal(scroller.children[0].children[0].src, "/p/paper/pages/one.webp");
    assert.equal(wheel(scroller).prevented, true, "达到边界后也不能缩放整个界面");
    r.PR.pageStep(1);
    assert.equal(scroller.style["--pv-page-width"], "400%");
    for (let i = 0; i < 20; i++) wheel(scroller, { deltaY: 1, deltaMode: 2 });
    assert.equal(scroller.style["--pv-page-width"], "50%");
    assert.equal(scroller.children[0].children[0].src, "/p/paper/pages/one.webp" + (mode === "server" ? "?w=1000" : ""));
  }
});

test("Ctrl wheel safely consumes empty-page and horizontal-only gestures", () => {
  const r = reader();
  const scroller = r.node(".pv-scroll");
  assert.equal(wheel(scroller).prevented, true);
  r.PR.togglePages(true);
  assert.equal(wheel(scroller, { deltaY: 0 }).prevented, true);
  assert.equal(scroller.style["--pv-page-width"], undefined);
});

test("server and offline readers draw separate regions and scroll to the first column", () => {
  for (const mode of ["server", "static"]) {
    const r = reader(mode);
    r.PR.state.layout.first = crossing();
    r.PR.openPage(1, "first");
    const regions = r.node(".pv-hl").children;
    assert.equal(regions.length, 2);
    assert.equal(regions[0].className, "pv-region");
    assert.equal(parseFloat(regions[0].style.left), 7.6);
    assert.equal(parseFloat(regions[1].style.left), 51.6);
    assert.ok(Math.abs(parseFloat(regions[0].style.height) - 30.6) < 0.000001);
    assert.equal(r.node(".pv-scroll").scroll.top, 528);
    assert.equal(r.node(".pv-page img").src, "/p/paper/pages/one.webp" + (mode === "server" ? "?w=1000" : ""));
  }
});

test("clicks hit either column fragment but leave the gutter and unrelated text alone", () => {
  const r = reader();
  r.PR.state.layout.first = crossing();
  r.PR.openPage(1, "first");
  const page = r.node(".pv-page");
  for (const [x, y, expected] of [[0.20, 0.75, "b-first"], [0.70, 0.20, "b-first"], [0.50, 0.70, null], [0.70, 0.75, null]]) {
    r.PR.jumped = null;
    page.listeners.click({ currentTarget: page, clientX: x * 1000, clientY: page.getBoundingClientRect().top + y * 1000 });
    assert.equal(r.PR.jumped, expected);
  }
});

test("legacy single boxes work and layout refresh replaces the visible regions", () => {
  const r = reader();
  r.PR.state.layout.first = { page: 1, box: [0.08, 0.60, 0.48, 0.90] };
  r.PR.openPage(1, "first");
  assert.equal(r.node(".pv-hl").children.length, 1);
  r.PR.state.layout.first = crossing();
  r.events.get("remote")(["layout"]);
  assert.equal(r.node(".pv-hl").children.length, 2);
});


test("continuous pages load nearby images and scrollbar updates the page without follow stealing it", () => {
  const r = reader();
  r.PR.state.paper.meta.pages = Array.from({ length: 27 }, (_, i) => ({ img: `pages/${i + 1}.webp`, w: 612, h: 792 }));
  r.PR.togglePages(true);
  const scroller = r.node(".pv-scroll");
  assert.equal(scroller.children.length, 27);
  assert.equal(scroller.children.filter(p => p.children[0].src).length, 3);
  scroller.listeners.pointerdown();
  scroller.scrollTop = 6 * 1018;
  scroller.listeners.scroll();
  assert.match(r.node(".pv-label").textContent, /7 \/ 27/);
  assert.equal(r.node('[data-pv="pdf"]').href, "/p/paper/source.pdf#page=7");
  assert.ok(scroller.children[6].children[0].src);
  r.read("second"); r.PR.syncPage(false);
  assert.match(r.node(".pv-label").textContent, /7 \/ 27/);
  assert.equal(r.PR.jumped, undefined);
  r.PR.pageStep(1);
  assert.equal(scroller.scroll.top, 7 * 1018);
});

test("right scrollbar moves text and highlights, respects follow, and hands control back", () => {
  const r = reader();
  r.node("b-first"); r.node("b-second");
  r.PR.state.layout.first = { page: 1, box: [0.1, 0.1, 0.9, 0.8] };
  r.PR.state.layout.second = { page: 2, box: [0.1, 0.1, 0.9, 0.8] };
  r.PR.togglePages(true);
  const scroller = r.node(".pv-scroll");
  scroller.scrollTop = 1018;
  scroller.listeners.scroll();
  assert.equal(r.scrolls.length, 0, "programmatic scrolling must not move text");
  scroller.listeners.scrollend();
  scroller.listeners.scroll();
  assert.equal(r.scrolls.length, 1, "native scrollbar must work without pointerdown");
  assert.equal(r.node(".pv-hl").children.length, 1);
  assert.equal(r.scrolls[0].behavior, "instant");
  const position = scroller.scroll;
  r.read("first"); r.PR.syncPage(false);
  assert.equal(scroller.scroll, position, "reverse sync must not pull the panel back");
  r.node(".pv-follow input").checked = false;
  scroller.scrollTop = 0; scroller.listeners.scroll();
  assert.equal(r.scrolls.length, 1, "unchecked follow must not move text");
  r.node(".pv-follow input").checked = true;
  r.documentEvents.get("wheel")({ target: { closest: () => null } });
  r.PR.syncPage(false);
  assert.notEqual(scroller.scroll, position, "left scrolling immediately resumes forward sync");
});
