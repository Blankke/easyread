/*
 * 用法：npm run dev；也可执行 node scripts/dev_desktop.cjs .。
 * 在同一份源码分别从 WSL 和 Windows 开发时，选用当前系统的 Electron 程序。
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const electronRoot = path.join(root, "node_modules", "electron");
const executable = process.platform === "win32" ? "electron.exe"
  : process.platform === "darwin" ? path.join("Electron.app", "Contents", "MacOS", "Electron")
  : "electron";
const locations = [path.join(electronRoot, `dist-${process.platform}-${process.arch}`), path.join(electronRoot, "dist")];
const binary = locations.map(folder => path.join(folder, executable)).find(file => fs.existsSync(file));

if (!binary) {
  console.error(`当前系统缺少 Electron 可执行文件（${process.platform}/${process.arch}）。请在当前系统安装 Electron。`);
  process.exitCode = 1;
} else {
  // IDE/代理进程有时设置 ELECTRON_RUN_AS_NODE；桌面启动必须清除它。
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(binary, process.argv.slice(2).length ? process.argv.slice(2) : ["."],
    { cwd: root, env, stdio: "inherit", windowsHide: false });
  child.on("error", error => {
    console.error(`启动 Electron 失败：${error.message}`);
    process.exitCode = 1;
  });
  child.on("close", (code, signal) => { process.exitCode = code == null ? (signal ? 1 : 0) : code; });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { if (!child.killed) child.kill(signal); });
}
