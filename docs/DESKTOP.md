# Windows 桌面基础（桌面预览）

桌面入口复用 `packages/frontend` 的实际业务页面；`design/meeting-workbench` 仍是独立的示例原型，没有接入桌面。

## 开发、构建与打包

需要 Windows x64、Node 24+（当前验证的后端/打包运行时为 26.7.0）与 npm。首次获取依赖：`npm ci`，然后 `node node_modules/electron/install.js` 下载锁定版本的 Electron 二进制。这是桌面框架，不是语音模型。

```powershell
npm run dev:desktop
npm run build
npm run package:desktop
```

`dev:desktop` 先构建 shared、backend、frontend、desktop，再启动 Electron，后端使用启动命令的 Node，窗口加载正式构建页面。编辑后重新执行即可；此入口不含热更新。浏览器开发入口 `npm run dev:backend` / `npm run dev:frontend` 保留；后端在仓库根读取配置，Vite 默认连接相同主机的 8787，可显式设置 `VITE_API_BASE` / `VITE_WS_URL`。前端开发使用 `http://127.0.0.1:5173` 或 `http://localhost:5173`，API 主机应与页面保持一致。

打包复用 `tools/package.mjs` 的已安装生产依赖闭包和独立 Node，添加 Electron 运行时，再使用 C# 原生安装向导。当前版本 `0.1.0-desktop-preview.11` 的产物在 `outputs/desktop-preview/v0.1.0-desktop-preview.11/RCC-Desktop-Preview-0.1.0-desktop-preview.11-Setup.exe`；以后按版本分别保存。程序未签名，无自动更新、托盘或云端发布。包中保留 Electron/Chromium 和 Node 许可证。

本轮 M1 修复版本为 `0.1.0-desktop-preview.2`；固化交付另存 `outputs/m1-desktop-preview.2/`，保留上一轮桌面基础安装包及证据。M1 的源码、桌面/浏览器检查与真实识别缺口见 [M1_VALIDATION.md](M1_VALIDATION.md)。

2026-10-23 的 CPU STT 配套桌面版本为 `0.1.0-desktop-preview.3`，交付目录 `outputs/stt-cpu-20261023/`。独立识别环境和所选 int8 模型位于 D 盘，不进入核心安装包。使用方法、真实固定语音验证和仍待完成的硬件验收见 [STT_CPU.md](STT_CPU.md)。

M2 会话恢复交付为 `0.1.0-desktop-preview.4`，安装包与证据保留在 `outputs/m2-desktop-preview.4/`，见 [M2_VALIDATION.md](M2_VALIDATION.md)。当前第 5 版新增可见版本、原生安装向导与开始菜单选项，版本流程见 [INSTALLER.md](INSTALLER.md)。

## 进程与生命周期

- Electron 主进程拥有单实例锁、窗口、权限提示和一个独立 Node 后端。页面启用 sandbox / contextIsolation，禁用 Node、webview、新窗口、页面导航和外部网络请求。
- 后端只监听 `127.0.0.1:0`，由操作系统分配端口，不探测或接管 8787。父子 IPC 的随机实例 ID、子进程 PID 与带私有访问头的健康检查一起确认就绪；页面 HTTP/WS 同源连接该实际端口。
- 关闭窗口或菜单「退出」均结束应用；没有隐藏常驻。录音/暂停/等待设备时先确认。随后停止前端采集、销毁采集页面，通过 IPC 请求后端停止录音、关闭服务与 SQLite。10 秒超时只终止持有句柄的那个子进程。强制终止或系统关机无法保证所有模型任务完成。
- 父进程崩溃会断开 IPC，后台自行清理；后台崩溃会切换为错误页并释放采集页面。错误页提供明确消息与日志目录。
- Python STT worker 仍由用户手动管理，桌面不会启动、接管或终止它。embedding 保持原 worker thread 结构；桌面禁止隐式下载模型权重。

## 程序与数据分离

| 内容 | 安装版默认位置 |
|---|---|
| 程序 | 用户选择的安装目录；本次旁路安装 `D:\Apps\实时会议助手-桌面预览` |
| 配置 | `%LOCALAPPDATA%\RCC-Desktop-Preview\.env` |
| SQLite | `%LOCALAPPDATA%\RCC-Desktop-Preview\data\rcc.sqlite` |
| 日志 | `%LOCALAPPDATA%\RCC-Desktop-Preview\logs\`（desktop.log 与每次启动的 backend 日志） |
| Chromium 用户状态 | `%LOCALAPPDATA%\RCC-Desktop-Preview\chromium\` |

开发使用独立的 `%LOCALAPPDATA%\RCC-Desktop-Dev`。`RCC_DESKTOP_USER_DATA` 可指定独立测试数据目录。首次启动只从 `.env.example` 创建缺失的配置；后续启动与重装不覆盖。桌面强制使用自己的数据库、静态页面和回环随机端口，因此 `.env` 中的 `DB_PATH` / `STATIC_DIR` / `HOST` / `PORT` 不控制桌面运行位置。其他相对路径以用户数据目录为基准。

不读取源码 `.env`、旧安装目录 `.env` 或旧数据库；没有自动数据迁移。保留旧版及其快捷方式。后续可先备份，再验证 JSON 导入或单独设计迁移。

M2 在当前桌面自己的同一数据库中新增 `workspace_state` 保存所选会议 ID，并为 `sessions` 增加可空 `duration_sec`（采集时长，不计暂停）。旧记录不会被复制、重写或补造时长；旧表结构的重复打开及原文保留有回归。旧记录没有准确采集时长时，列表明确标注；原有完成记录的显示时钟仍可使用起止跨度。

“结束”释放采集并排空已接收音频和派生任务，随后保留当前会议供阅读/提问；“关闭会议”才清空画面，原记录仍在本机列表。直接关窗仍是退出应用，之后重启恢复上次选中的已保存会议。若上次异常中断，只恢复已保存内容并显示未正常结束，不自动连接 STT 或打开设备。新建录音是新会议，不向历史原文追加。

默认三种模型均为模拟模式。真实 STT 需另备 Python、模型和手动 worker；真实 LLM 需明确配置服务/密钥；真实 embedding 需另备运行时和本地缓存。缺少真实 LLM 密钥时桌面启动明确失败，不回退模拟。核心包不包含密钥、个人会议、数据库、临时测试资料和大型模型。

开始前显示语音配置、问答与检索的模式。模拟配置下“麦克风录音”明确拒绝；真实配置下先检查 worker 的 ready 协议，再请求设备。暂停释放麦克风，继续录音复用仍连接的单客户端 STT 通道；已失败时提示结束并重新开始。就绪信息仅证明通道可连接，不证明模型准确率。模拟讲解的暂停会冻结剩余讲稿，继续后接着播放。

## 安全与验证边界

桌面专用后端要求随机私有访问头并限制 Host/Origin；此访问头由 Electron 网络层添加，页面桥接不返回它。桥接仅支持退出准备、采集状态、固定日志目录和启动状态。麦克风仅允许本窗口的本源音频请求，首次请求需明确同意；相机、屏幕采集及其他权限拒绝，Windows 权限仍会限制设备。权限同意仅在本次应用运行中有效。

本轮同时修复新源码的浏览器入口：限定回环 Host 与本应用/Vite 的精确 Origin；本地引导设置端口专属 HttpOnly / SameSite=Strict 凭证，HTTP 与 WS 共用，重连时刷新凭证。无凭证 `/health` 只报告最小应用身份与存活状态，不泄露会话或配置。浏览器页面依然只能作为本机应用使用，这些规则不隔离同一用户的其他本地进程，也不是完整安全审计。旧安装版未更新，旧浏览器启动器探测/停止的 I13 仍待修复。

开始/停止竞态与模拟暂停已有自动回归；M2 已补齐停止后问答、近期原文与刷新/历史恢复。M3 已实现索引和导图的显式限量补建，导图进度见 [M3_GRAPH_VALIDATION.md](M3_GRAPH_VALIDATION.md)。第9版补齐可观测音频缺口与源时间映射基础，见 [M3_AUDIO_VALIDATION.md](M3_AUDIO_VALIDATION.md)；无逐帧送达确认，不能据此证明内容完整。完整自动恢复、摘要/引用与工作台接入仍待完成；恢复不等于补齐丢失音频或所有派生内容。

自动验证使用 `npm run test:desktop`。带参数时直接执行 `node tools/verify-desktop.mjs --installer=<当前版本安装包> --install-mode=wizard --work=<全新目录>`，避免不同 npm 版本的参数转发差异。向导独立回归用 `npm run test:installer-wizard`。初始桌面覆盖范围见 [DESKTOP_VALIDATION.md](DESKTOP_VALIDATION.md)，当前安装器说明见 [INSTALLER.md](INSTALLER.md)。真实设备与真实 STT 不由页面打开或模拟讲稿代替。

浏览器回归在 `npm run build` 后运行 `npm run test:browser`；使用本机已有 Edge、独立配置/数据库/浏览器状态，检查正式页面、Vite、后端重启和陌生来源拒绝，不启动真实模型。默认 Vite 端口 5173 必须空闲；脚本只清理自己创建的进程。

第11版在同一桌面业务页面新增实时索引/导图任务记录与范围筛选，重启和非空重装保留。最终538项测试、48项开发桌面、57项正式安装桌面及7项实际D盘升级检查通过；详见 [实时任务验证](M3_LIVE_VALIDATION.md)。按用户最新指示，后续由GPT agents协作，本次Qoder排队调用已停止。启动、退出、配置与数据位置沿用上述规则。
