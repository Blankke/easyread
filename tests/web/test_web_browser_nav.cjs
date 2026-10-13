/* 用法：node --test tests/web/test_web_browser_nav.cjs。
 * 检查两种页面的顶栏入口仅调用既有桌面网页容器，不修改翻译任务。
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const root = path.join(__dirname, "../../easyread/web");
const script = fs.readFileSync(path.join(root, "js/common/web-browser.js"), "utf8");

test("文献库和阅读页都提供桌面网页入口", () => {
  const css = fs.readFileSync(path.join(root, "css/base.css"), "utf8");
  assert.match(css, /#chatgptBrowserBtn\[hidden\]\s*\{\s*display:\s*none/);
  for (const file of ["library.html", "reader.html"]) {
    const html = fs.readFileSync(path.join(root, file), "utf8");
    assert.match(html, /<header[^>]*class="topbar"[\s\S]*?id="chatgptBrowserBtn"[\s\S]*?<\/header>/);
    assert.match(html, /<script src="\/web\/js\/common\/web-browser.js"><\/script>/);
  }
});

test("顶栏打开只调用现有网页的 show，普通浏览器不显示入口", async () => {
  const listeners = {};
  const button = { hidden: true, disabled: false, addEventListener(name, handler) { listeners[name] = handler; } };
  const PR = { $: () => button, t: text => text, esc: text => text, toast() { throw new Error("不应报错"); } };
  let opened = 0;
  vm.runInNewContext(script, { window: { PR, easyreadDesktop: { chatgptOpen: async () => { opened++; } } } });
  assert.equal(button.hidden, false);
  assert.equal(button.textContent, "打开 ChatGPT 网页");
  await listeners.click();
  assert.equal(opened, 1);
  assert.equal(button.disabled, false);

  const browserButton = { hidden: true, addEventListener() { throw new Error("普通浏览器不应绑定点击"); } };
  vm.runInNewContext(script, { window: { PR: { ...PR, $: () => browserButton } } });
  assert.equal(browserButton.hidden, true);
});
