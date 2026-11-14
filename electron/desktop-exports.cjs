/* Export to the normal download directory, or an explicitly selected destination. */
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function registerExports({ app, ipcMain, dialog, getWindow, trustedWindow }) {
  const choices = new Map();
  ipcMain.handle("easyread:export-directory", event => {
    trustedWindow(event);
    return app.getPath("downloads");
  });
  ipcMain.handle("easyread:save-export", async (event, payload) => {
    trustedWindow(event);
    if (!payload || typeof payload.filename !== "string") throw new Error("Invalid export");
    const filename = path.basename(payload.filename), extension = path.extname(filename).toLowerCase();
    if (![".md", ".zip"].includes(extension)) throw new Error("Unsupported export format");
    const pick = () => dialog.showSaveDialog(getWindow(), {
      defaultPath: app ? path.join(app.getPath("downloads"), filename) : filename,
      filters: [{ name: extension === ".md" ? "Markdown" : "ZIP", extensions: [extension.slice(1)] }],
      properties: ["showOverwriteConfirmation", "createDirectory"],
    });
    if (payload.choose === true) {
      const choice = await pick();
      if (choice.canceled || !choice.filePath) return false;
      const token = randomUUID();
      if (choices.size >= 32) choices.delete(choices.keys().next().value);
      choices.set(token, {filename, filePath:choice.filePath});
      return {token, path:choice.filePath};
    }
    if (typeof payload.data !== "string" || payload.data.length > 90 * 1024 * 1024 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(payload.data)) throw new Error("Invalid export");
    if (payload.default === true && !payload.token) {
      const directory = app.getPath("downloads"), data = Buffer.from(payload.data, "base64");
      await fs.mkdir(directory, {recursive:true});
      // Keep existing notes when the same document is exported more than once.
      for (let n = 0; n < 10000; n++) {
        const name = n ? path.basename(filename, extension) + ` (${n})` + extension : filename;
        try { await fs.writeFile(path.join(directory, name), data, {flag:"wx"}); return true; }
        catch (err) { if (err.code !== "EEXIST") throw err; }
      }
      throw new Error("Too many exports with the same filename");
    }
    const choice = payload.token ? choices.get(payload.token) : await pick();
    if (!choice || (payload.token && choice.filename !== filename)) throw new Error("Choose the export location again");
    if (choice.canceled || !choice.filePath) return false;
    await fs.writeFile(choice.filePath, Buffer.from(payload.data, "base64"));
    if (payload.token) choices.delete(payload.token);
    return true;
  });
}
module.exports = { registerExports };
