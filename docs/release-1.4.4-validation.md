# 1.4.4 发布前验证

验证日期：2026-10-20；安装包对应源码提交 `061853a191025533780e6ebcad01b56d6dbbda9f`

- 本地 Python 520 项、前端与桌面 195 项测试通过，包含 PDF 文字缓存、空格保留、脚注依赖、图表渲染与版本相关检查
- [跨平台 CI](https://github.com/Edwardxlai/easyread/actions/runs/39419378326)：Windows、macOS、Linux 的 Python 3.10 / 3.12 测试与启动检查全部通过
- [安装包构建](https://github.com/Edwardxlai/easyread/actions/runs/39419379852)：Windows x64、macOS arm64、Linux AppImage 构建、冻结后端冒烟与 Linux glibc 检查通过；手动构建未发布 Release
- 已下载四个安装载体（EXE、DMG、Mac ZIP、AppImage），逐项核对更新清单版本、大小及 SHA-512；更新清单均为 1.4.4，附件含对应 blockmap
- 本地 Windows 打包产物中的 `app.asar` 版本为 1.4.4；冻结后端实测 PDF 导入、文字/坐标抽取、Web 资源和多尺寸原页图片通过；冒烟脚本显式以 UTF-8 解码后端输出，避免 Windows GBK 环境出现日志解码异常
- 独立测试文献库中的真实 14 页论文，浏览器确认原页文字层、带空格复制和 125% 缩放；未使用日常文献库
- Codex CLI 实测一页 PDF 翻译并保存译文，补充要求保留 `EasyRead` 名称；图片问答正确读出测试页文字
- 阅读页实测粘贴 PNG → 预览 → Codex 图片问答 → 刷新 → 历史对话回读，附图和回答均保留
- PDF 原页标注、便签和带批注 PDF 导出原型按 [#101](https://github.com/Edwardxlai/easyread/issues/101) 已确认的产品边界排除；原页选字复制保留

验证边界：Claude CLI 在本机未登录，该引擎的真实调用未通过；未逐一验收全部模型供应商、复杂排版与扫描 PDF。三平台构建和后端冒烟不等于三平台安装后的人工体验验收；1.4.3 → 1.4.4 的真实应用内升级须在发布后使用正式更新源验证

后续仅调整此记录、更新日志与冒烟脚本的提交不改变上述安装包中的应用源码
