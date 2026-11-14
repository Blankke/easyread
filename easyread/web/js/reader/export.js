/* 导出笔记：勾选要哪些（我的笔记、划线、我的问题、AI 的回答和解释、论文笔记、问 AI 的对话），导出 Markdown。 */
(function (PR) {
  "use strict";
  const S = PR.state;
  const exportFilename = () => ((S.paper.meta || {}).short_zh || (S.paper.meta || {}).title_zh || PR.t("论文")).replace(/[\\/:*?"<>|]/g, "") + PR.t("-笔记.md");
  const KINDS = [
    ["paper", PR.t("论文笔记（整篇的感悟）")], ["note", PR.t("我的笔记")], ["highlight", PR.t("我的划线")], ["question", PR.t("我的问题")],
    ["ai", PR.t("AI 的回答和解释（页边）")], ["chat", PR.t("问 AI 的对话记录")], ["quote", PR.t("每条附上原文引用")],
  ];

  function counts() {
    const notes = PR.myNotes();
    return {
      paper: (S.reader.paper_note || {}).body ? 1 : 0,
      note: notes.filter((n) => n.kind === "note" || (n.kind !== "question" && n.kind !== "highlight")).length,
      highlight: notes.filter((n) => n.kind === "highlight").length,
      question: notes.filter((n) => n.kind === "question").length,
      ai: (S.discussion.entries || []).length,
    };
  }

  PR.openExport = function () {
    const c = counts();
    const saved = PR.ls.get("easyread-export", { paper: true, note: true, highlight: true, question: true, ai: true, chat: false, quote: true });
    const body = '<div class="exp-opts">' +
      KINDS.map(([k, l]) => '<label><input type="checkbox" data-exp="' + k + '"' + (saved[k] ? " checked" : "") + ">" + l +
        (c[k] != null ? '<span class="n">' + PR.t("{n} 条", { n: c[k] }) + "</span>" : "") + "</label>").join("") +
      '</div>';
    PR.openExportDialog({title:PR.t("导出笔记"), filename:exportFilename(), body, prepare});
  };

  async function prepare(dlg) {
      const pick = {};
      PR.$$("[data-exp]", dlg).forEach((i) => (pick[i.dataset.exp] = i.checked));
      PR.ls.set("easyread-export", pick);
      let chat = [];
      if (pick.chat) {
        let data = S.chat || {};
        if (PR.store.mode === "server") {
          data = await PR.api("/api/p/" + PR.pid + "/chat");
        }
        chat = data.threads ? data.threads.flatMap((t) => t.messages || []) : data.messages || [];
      }
      const text = PR.notesMarkdown(pick, chat);
      return new Blob([text], {type:"text/markdown;charset=utf-8"});
  }
})(window.PR);
