/* 用法：阅读页在 pageview.js 前加载本文件；按钮与 Ctrl+滚轮共用原页缩放状态。 */
(function (PR) {
  "use strict";
  PR.bindPageZoom = function (setZoom, getZoom) {
    const panel = PR.$("#pageview");
    panel.addEventListener("click", event => {
      const button = event.target.closest("[data-pv-zoom]");
      if (!button) return;
      const action = button.dataset.pvZoom;
      setZoom(action === "fit" ? 1 : getZoom() + (action === "in" ? 0.25 : -0.25));
    });
  };
  PR.updatePageZoom = function (value) {
    PR.$(".pv-zoom-value").textContent = Math.round(value * 100) + "%";
    PR.$('[data-pv-zoom="out"]').disabled = value <= 0.5;
    PR.$('[data-pv-zoom="in"]').disabled = value >= 4;
  };
})(window.PR);
