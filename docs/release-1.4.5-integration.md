# 1.4.5 整合与发布验证记录

日期：2026-10-26（Asia/Singapore）

## 整合范围

- 基线：`main` / `v1.4.4`，`4d00a94403218829b7fba98833f47de44968df3e`
- 发布候选分支：`codex/release-1.4.5`；通过 [PR #115](https://github.com/Edwardxlai/easyread/pull/115) 合入 main
- 保留 PR #105 原提交 `6c7321f`、PR #111 原提交 `912ae27` 的提交关系
- 纳入 #100/#103/#104/#106/#107/#108 与提示词编辑的工作区快照 `3f8f98a`
- 纳入 #109/#110 的修复及图片缩放，分支提交截至 `da124c6`
- 纳入 ZCode CLI 实验性适配快照 `8dd9093`；保留此前恢复的模型卡片布局
- 原有工作区及未提交修改保持原样；快照通过独立临时 Git 索引生成
- PR #113 富文本笔记与导图、#114 常驻目录未纳入

## 整合时修正

- 合并图片裁剪与缩放的 CSS 引用、双方语言词条，以及 OpenCode / ZCode 引擎注册，未以一方覆盖另一方
- 正式 Electron 入口加载标签页；启动及运行中的外部论文链接打开到标签内，支持桌面标签快捷键
- 标签关闭、桌面退出、重启和更新前等待保存；明确保存失败时保留窗口及后端
- 文献库和阅读器子页面经同源标签壳复用主窗口桌面桥；保留主进程对主框架 IPC 的校验
- 新导出窗口的错误信息转义后显示，避免被当成 HTML
- 同步旧测试对导出入口、设置模块和渲染辅助层的依赖
- Python、Electron、npm 锁文件统一为 1.4.5，补齐 CHANGELOG
- CI 发现 OpenCode 在未配置代理时收到空环境对象，已修正为继承本机环境并覆盖适配参数；补齐新增繁体中文词条及导入重试测试参数
- 真实 Electron 检查发现标签栏未跟随主题，已同步当前页面的主题，并监听后续切换

## 本轮检查

58 项 Python 定向测试通过：`tests.test_issue_preview`、`tests.engines.test_zcode_cli`、`tests.translate.test_instructions`、`tests.server.test_page_cap`、`tests.pdf.test_prepare_worker`、`tests.pdf.test_render_limits`、`tests.library.test_fs_retry`、`tests.server.test_prepare_retry`、`tests.app.test_release_i18n`

88 项前端与桌面定向测试在修正后通过：`test_desktop`、`test_tab_bridge`、`test_desktop_updates`、`test_export_save`、`test_reader_progress`、`test_figure_zoom`、`test_table_render`、`test_settings_page_cap`、`test_codebuddy_settings`、`test_chat_ui`、`test_chat_export`

执行方式为 `python -m unittest <上述模块>` 与 `node --test <上述文件>`；首轮出现测试依赖不完整，更新后复跑受影响文件。最后一轮组合检查 83 项通过、5 项渲染测试失败，补齐渲染辅助层的测试替身后，这 5 项单独复跑通过；未重复全套项目测试

`python scripts/i18n_check.py`：缺英文 0，未包裹中文 0；保留未使用的历史词条

## 尚未覆盖

- 打包后的 Windows/macOS/Linux 安装与跨版本应用内升级
- 文件选择与导出的原生对话框交互；桌面桥实际调用已验证，但本轮没有向日常下载目录写入导出文件
- OpenCode / ZCode 真实登录账号的翻译、图片问答与取消；适配逻辑测试不证明外部服务可用
- #109 反馈者原 PDF 和同步盘环境；已覆盖错误恢复与内存保护逻辑，未宣称原环境全部解决

## 发布前复核

- 应用代码提交 `9b92f40f6893b468c501dbff578f0942fe124608` 的 [三平台 CI](https://github.com/Edwardxlai/easyread/actions/runs/40212361862) 全部通过：Windows、macOS、Linux 的 Python 3.10 / 3.12 测试，以及安装后的服务启动与一键启动脚本检查。Python 554 项（1 项跳过），前端与桌面 227 项
- 首轮候选 `7cd4533` 的 [安装包构建](https://github.com/Edwardxlai/easyread/actions/runs/40211812745) 通过 Windows x64、macOS arm64、Linux AppImage 打包、冻结后端冒烟及 Linux glibc 检查；它早于上述 OpenCode 和主题修正，不能用作最终发布附件
- 独立测试文献库使用生成的两篇 PDF，真实 Electron 加载正式 `electron/main.cjs`、preload 和 Python 后端；打开、切换、重复打开去重、关闭标签、全部保存、同源子页面桌面桥及主题实时同步通过，没有控制台错误。窗口以隐藏方式运行并捕获截图，未操作日常文献库
- 上述修复后，本地 15 项受影响 Python 测试与 3 项桌面桥检查通过
- 最终安装包由 `v1.4.5` 标签工作流重新构建，结果见 [发布工作流](https://github.com/Edwardxlai/easyread/actions/workflows/release.yml) 与 [正式 Release](https://github.com/Edwardxlai/easyread/releases/tag/v1.4.5)；本记录中的构建检查不等于三平台安装后的人工验收
