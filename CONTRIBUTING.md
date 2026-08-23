# 参与贡献 / Contributing

## 中文

感谢你愿意帮助改进困困截图工具。项目目前以 macOS 为首要平台，重点是可靠的截图、贴图、OCR、录屏和清晰的数据边界。

### 开始之前

- 安全漏洞请按 [SECURITY.md](SECURITY.md) 私密报告，不要在公开 Issue 中披露。
- 功能建议或普通缺陷请先搜索已有 Issue，避免重复。
- 涉及较大行为变化、依赖变化或 UI 重做时，建议先开 Issue 对齐范围。
- Issue、测试数据和演示素材不得包含真实 API Key、个人信息或未授权内容。

### 本地开发

需要 Node.js 22.12 或更高版本，以及 npm：

```bash
git clone https://github.com/duangjaiignacy-blip/kunkun-shot.git
cd kunkun-shot
npm ci
npm test
npm start
```

macOS 截图与录屏依赖“系统设置 → 隐私与安全性 → 屏幕录制”权限。开发模式通常显示为 Electron 或启动它的终端。授权后需完全退出并重新启动进程。

### 提交改动

1. 从最新默认分支创建一个范围清晰的分支。
2. 保持主进程为 CommonJS、渲染层为无框架 HTML/CSS/JavaScript；渲染层不得绕过 preload 直接访问 Node 或 Electron。
3. 修复缺陷时添加能先复现问题的回归测试；安全边界变化也应有测试。
4. 不要提交 `.env`、本地配置、证书、签名身份、用户截图、历史记录或构建产物。
5. 提交前运行：

```bash
npm test
npm audit --omit=dev
npm ls --depth=0
```

若改动涉及界面、截图权限、OCR、录屏、全局快捷键或贴图，请在 Pull Request 中列出已完成的真机验证环境与步骤；未验证项目要明确标注。

### Pull Request 说明

请保持 PR 聚焦，并写清：问题、方案、风险、测试证据、手动验证结果，以及数据或网络行为是否变化。UI 改动可附脱敏截图。提交贡献即表示你同意按本仓库的 MIT 许可证提供该贡献。

## English

Thanks for helping improve Kunkun Shot. The project is currently macOS-first and focuses on reliable capture, pinning, OCR, recording, and explicit data boundaries.

### Before you start

- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md); do not disclose them in public issues.
- Search existing issues before filing a feature request or regular bug.
- For broad behavior changes, dependency changes, or UI redesigns, open an issue first to align on scope.
- Never include real API keys, personal information, or unauthorized content in issues, fixtures, or demo assets.

### Local development

Node.js 22.12 or later and npm are required:

```bash
git clone https://github.com/duangjaiignacy-blip/kunkun-shot.git
cd kunkun-shot
npm ci
npm test
npm start
```

On macOS, capture and recording require **System Settings → Privacy & Security → Screen Recording**. Development builds may appear as Electron or the terminal that launched it. Fully quit and restart the process after granting access.

### Making changes

1. Create a focused branch from the latest default branch.
2. Keep the main process in CommonJS and the renderer in framework-free HTML/CSS/JavaScript. Renderer code must use the preload bridge instead of accessing Node or Electron directly.
3. Bug fixes should add a regression test that demonstrates the failure first. Security-boundary changes also need tests.
4. Do not commit `.env` files, local configuration, certificates, signing identities, user captures, history data, or build artifacts.
5. Before submitting, run:

```bash
npm test
npm audit --omit=dev
npm ls --depth=0
```

For UI, screen-permission, OCR, recording, global-shortcut, or pin-window changes, list the actual device and steps used for manual verification. Clearly identify anything that remains unverified.

### Pull requests

Keep pull requests focused and describe the problem, approach, risk, test evidence, manual checks, and any change to data or network behavior. Redacted screenshots are welcome for UI work. By contributing, you agree that your contribution is provided under this repository's MIT license.
