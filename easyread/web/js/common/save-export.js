/* Keep ordinary downloads as the default; choosing a destination is optional. */
(function (PR) {
  "use strict";
  const desktopBridge = () => window.easyreadDesktop || (window.parent !== window ? window.parent.easyreadDesktop : null);
  async function encoded(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(binary);
  }
  async function writeFile(file, blob) {
    const output = await file.createWritable();
    try { await output.write(blob); await output.close(); }
    catch (error) { await output.abort().catch(() => {}); throw error; }
    return 'saved';
  }
  PR.canChooseExportFile = () => !!(desktopBridge()?.saveExport || window.showSaveFilePicker);
  PR.exportDirectory = async () => desktopBridge()?.exportDirectory ? desktopBridge().exportDirectory() : PR.t("由浏览器管理下载位置");
  PR.chooseExportFile = async function (filename) {
    const desktop = desktopBridge();
    if (desktop?.saveExport) {
      const choice = await desktop.saveExport({filename, choose:true});
      if (!choice) return false;
      return {name:choice.path, save:async blob => await desktop.saveExport({filename, token:choice.token, data:await encoded(blob)}) ? 'saved' : false};
    }
    if (!window.showSaveFilePicker) return false;
    try {
      const zip = filename.endsWith('.zip');
      const file = await window.showSaveFilePicker({suggestedName:filename, types:[{description:zip ? 'ZIP' : 'Markdown', accept:zip ? {'application/zip':['.zip']} : {'text/markdown':['.md']}}]});
      return {name:file.name || filename, save:blob => writeFile(file, blob)};
    } catch (err) { if (err.name === 'AbortError') return false; throw err; }
  };
  PR.saveExport = async function (blob, filename, destination = null) {
    if (destination) return destination.save(blob);
    const desktop = desktopBridge();
    if (desktop?.exportDirectory && desktop?.saveExport) {
      return await desktop.saveExport({filename, default:true, data:await encoded(blob)}) ? 'saved' : false;
    }
    return PR.downloadExport(blob, filename);
  };
  PR.downloadExport = function (blob, filename) {
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return 'download';
  };
})(window.PR);
