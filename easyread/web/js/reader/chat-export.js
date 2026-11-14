(function (PR) {
  "use strict";
  PR.exportChatMarkdown = async function (thread, id, button) {
    if (button.disabled) return;
    button.disabled = true;
    try {
      const result = await PR.api('/api/p/' + PR.pid + '/chat-export', {method:'POST', body:{thread, id}});
      const bytes = Uint8Array.from(atob(result.data), c => c.charCodeAt(0));
      const blob = new Blob([bytes], {type:result.mime});
      PR.openExportDialog({title:PR.t("导出回答"), filename:result.filename, prepare:async () => blob});
    } catch (err) { PR.toast(PR.t("导出失败：{msg}", {msg:err.message})); }
    finally { button.disabled = false; }
  };
})(window.PR);
