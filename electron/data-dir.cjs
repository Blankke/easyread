// Windows 安装版的数据跟着安装目录走：<安装目录>\data。装到 E 盘，论文库和设置也都在 E 盘。
// 安装目录写不进去（装在 Program Files 之类）时退回 ~/EasyRead，和以前一样。
// 1.3.1 及以前的数据在 ~/EasyRead：第一次启动时整份搬过来，核对无误后删掉旧的。
// 安装脚本（installer/installer.nsh）在更新和卸载时会留下 data 文件夹。
const fs = require("fs");
const os = require("os");
const path = require("path");

const legacyDir = home => path.join(home || os.homedir(), "EasyRead");

function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, "");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function files(root, rel = "") {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const sub = path.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...files(root, sub));
    else if (entry.isFile()) out.push(sub);
  }
  return out;
}

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

// 设置里的文献库在旧目录里面时，换成新目录里的同一个位置；放在别处的不动
function rewriteLibrary(copy, legacy, dir) {
  const file = path.join(copy, "config.json");
  if (!fs.existsSync(file)) return;
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  const lib = cfg.library_dir;
  if (!lib) return;
  const rel = path.relative(legacy, lib);
  if (samePath(lib, legacy) || (rel && !rel.startsWith("..") && !path.isAbsolute(rel))) {
    cfg.library_dir = path.join(dir, rel);
    fs.writeFileSync(file, JSON.stringify(cfg, null, 1), "utf8");
  }
}

async function migrate(dir, legacy, log) {
  if (fs.existsSync(path.join(dir, "config.json")) || !fs.existsSync(path.join(legacy, "config.json"))) return;
  if (samePath(dir, legacy)) return;
  // 先拷到旁边的临时目录，拷完、核对完再改名：中途断电也不会留下半份“已迁移”的数据
  const staging = `${dir}.migrating`;
  await fs.promises.rm(staging, { recursive: true, force: true });
  await fs.promises.cp(legacy, staging, { recursive: true, force: true });
  const missing = files(legacy).filter(rel => {
    try {
      return fs.statSync(path.join(staging, rel)).size !== fs.statSync(path.join(legacy, rel)).size;
    } catch {
      return true;
    }
  });
  if (missing.length) throw new Error(`migrate: ${missing.length} files differ, e.g. ${missing[0]}`);
  rewriteLibrary(staging, legacy, dir);
  if (fs.existsSync(dir)) {
    // 目录已存在但没有 config.json（只有写入测试留下的空目录）：把拷贝的内容移进去
    for (const name of fs.readdirSync(staging)) await fs.promises.rename(path.join(staging, name), path.join(dir, name));
    await fs.promises.rmdir(staging);
  } else {
    await fs.promises.rename(staging, dir);
  }
  log(`migrated ${legacy} -> ${dir}`);
  try {
    await fs.promises.rm(legacy, { recursive: true, force: true });
  } catch (error) {
    log(`old data left at ${legacy}: ${error.message}`);
  }
}

// 返回给后端用的数据目录（设成 EASYREAD_HOME）；不用改时返回 null
// opts 只给测试用：{ exe, home, platform, env }
async function prepare(app, log = () => {}, opts = {}) {
  if (!app.isPackaged || (opts.platform || process.platform) !== "win32") return null;
  // 便携版的进程运行在临时解压目录；数据必须跟随用户双击的外层 EXE。
  const portable = (opts.env || process.env).PORTABLE_EXECUTABLE_DIR;
  const dir = path.join(portable || path.dirname(opts.exe || process.execPath), "data");
  const legacy = legacyDir(opts.home);
  if (!writable(dir)) return null;
  // 便携版独立保存数据，不自动搬走本机已有安装版或源码版的数据。
  if (portable) return dir;
  try {
    await migrate(dir, legacy, log);
  } catch (error) {
    // 搬不过去就继续用旧目录，数据不能丢
    log(`migrate failed, keep using ${legacy}: ${error.stack || error.message}`);
    if (!fs.existsSync(path.join(dir, "config.json"))) return null;
  }
  return dir;
}

module.exports = { prepare };
