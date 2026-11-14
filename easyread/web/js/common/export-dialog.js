/* One destination workflow for notes and individual AI answers. */
(function (PR) {
  "use strict";
  const dlg = PR.$("#readerDlg");
  let current = null;

  PR.openExportDialog = async function ({title, filename, body = "", prepare}) {
    current = {filename, prepare, destination: null};
    const session = current;
    dlg.querySelector(".dialog").innerHTML = '<div data-export-dialog><h2>' + PR.esc(title) + '</h2>' + body +
      '<div class="export-destination"><label class="field"><span>' + PR.t("文件名") + '</span><input class="input" data-export-name readonly value="' + PR.esc(filename) + '" title="' + PR.esc(filename) + '"></label>' +
      '<div class="field"><span>' + PR.t("保存位置") + '</span><div class="model-row"><input class="input" data-export-location readonly aria-label="' + PR.t("保存位置") + '" value="' + PR.t("正在读取…") + '">' +
      (PR.canChooseExportFile() ? '<button class="btn line" data-export-pick>' + PR.t("更改…") + '</button>' : '') + '</div></div></div>' +
      '<div class="actions"><button class="btn" data-export-close>' + PR.t("取消") + '</button><button class="btn primary" data-export-go>' + PR.t("导出") + '</button></div></div>';
    dlg.classList.add("open");
    try {
      const directory = await PR.exportDirectory();
      if (current === session && !session.destination) {
        const location = dlg.querySelector('[data-export-location]');
        location.value = location.title = directory;
      }
    } catch (err) {
      if (current === session && !session.destination) dlg.querySelector('[data-export-location]').value = PR.t("无法读取保存位置，请选择位置");
    }
  };

  dlg.addEventListener("click", async (e) => {
    if (!current || !dlg.querySelector('[data-export-dialog]')) return;
    if (e.target.closest('[data-export-close]')) { current = null; dlg.classList.remove('open'); return; }
    const choose = e.target.closest('[data-export-pick]');
    const save = e.target.closest('[data-export-go]');
    if ((!choose && !save) || (choose || save).disabled) return;
    const session = current;
    const buttons = [...dlg.querySelectorAll('[data-export-pick], [data-export-go]')];
    buttons.forEach(b => { b.disabled = true; });
    try {
      if (choose) {
        const destination = await PR.chooseExportFile(session.filename);
        if (current !== session || !destination) return;
        session.destination = destination;
        const location = dlg.querySelector('[data-export-location]');
        location.value = location.title = destination.name;
        const name = dlg.querySelector('[data-export-name]');
        name.value = name.title = destination.name.split(/[\\/]/).pop();
      } else {
        const blob = await session.prepare(dlg);
        if (current !== session) return;
        const result = await PR.saveExport(blob, session.filename, session.destination);
        if (result && current === session) {
          current = null;
          dlg.classList.remove('open');
          PR.toast(result === 'download' ? PR.t("已交给浏览器下载") : PR.t("已保存"));
        }
      }
    } catch (err) { PR.toast(PR.esc(PR.t("导出失败：{msg}", {msg: err.message}))); }
    finally { buttons.forEach(b => { b.disabled = false; }); }
  });
})(window.PR);
