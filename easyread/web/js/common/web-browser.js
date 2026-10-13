/* 用法：由 library.html 和 reader.html 在 util.js 后加载。
 * 桌面版顶栏显示“打开 ChatGPT 网页”；只切换已有网页容器的可见性，后台任务继续运行。
 */
(function (PR) {
  "use strict";
  const button = PR.$("#chatgptBrowserBtn");
  const desktop = window.easyreadDesktop;
  if (!button || !desktop || typeof desktop.chatgptOpen !== "function") return;
  button.hidden = false;
  button.textContent = PR.t("打开 ChatGPT 网页");
  button.title = PR.t("查看内嵌网页；正在进行的翻译会继续");
  button.addEventListener("click", async () => {
    if (button.disabled) return;
    button.disabled = true;
    try {
      // 主进程只调用 show()，不会重新创建网页、领取任务或重置当前会话。
      await desktop.chatgptOpen();
    } catch (error) {
      PR.toast(PR.t("打开 ChatGPT 网页失败：{msg}", { msg: PR.esc(error.message || String(error)) }));
    } finally {
      button.disabled = false;
    }
  });
})(window.PR);
