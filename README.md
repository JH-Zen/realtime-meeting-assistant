# 实时会议助手 · Real-time Cognitive Companion

面向会议、课堂和讲座的实时记录原型：**语音转写 → 增量思维导图 → 摘要与检索 → 带时间引用的问答**。

项目以 vibe coding 方式开发，当前处于原型完善阶段。默认使用模拟数据，无需 API Key 和模型文件即可体验界面与流程。

## 当前功能

- 实时字幕：区分临时识别与最终转写，最终内容存入 SQLite。
- 增量导图：支持节点摘要、折叠、拖拽和位置保存。
- 阶段摘要：后端生成、分层合并和存储，暂未提供展示面板。
- 内容问答：组合近期原文、历史检索、摘要与导图，流式返回回答。
- 时间引用：回答附带转写时间标签。
- 会话文件：支持 JSON 导出、导入和历史会话问答。
- 本机会议：结束录音后继续阅读和提问；支持列表打开、刷新与重启恢复，关闭会议会清空当前画面。
- 派生内容补建：复习模式显示检索索引和导图处理进度，可手动限量补建；旧导图进度未知时明确提示风险。详见 [导图补建验证](docs/M3_GRAPH_VALIDATION.md)。
- 音频缺口：记录新采集链路中观察到或可能丢失的区间，页面显示并随会话文件保存；没有记录不代表音频完整。详见 [音频缺口验证](docs/M3_AUDIO_VALIDATION.md)。
- 处理任务记录：保存本机实时索引/导图和手动补建的批次尝试与结果，区分成功、部分、失败、积压和中断，重启后保留。录音或复习时可按范围筛选最近10条；不补造旧记录，摘要/问答审计仍未覆盖。详见 [补建任务验证](docs/M3_TASK_VALIDATION.md) 与 [实时任务验证](docs/M3_LIVE_VALIDATION.md)。
- 可切换模拟/真实 STT、LLM 和 embedding，提供调试面板及 Windows 打包脚本。

## Windows 安装包

- **桌面预览**：当前版本为 `0.1.0-desktop-preview.11`，带原生安装向导。源码和配套安装包按用户要求上传GitHub，见 [本版预览](https://github.com/JH-Zen/realtime-meeting-assistant/releases/tag/v0.1.0-desktop-preview.11) 与 [版本说明](docs/releases/v0.1.0-desktop-preview.11.md)。本地产物在 `outputs/desktop-preview/v0.1.0-desktop-preview.11/`。旁路位置仍为 `D:\Apps\实时会议助手-桌面预览`，快捷方式为「实时会议助手（桌面预览）」，旧版保留。
- 版本号同时显示在应用标题、“帮助 → 关于”、安装向导和安装包文件名；后续开发交付提升版本并更新 [CHANGELOG.md](CHANGELOG.md)。向导与版本命令见 [INSTALLER.md](docs/INSTALLER.md)。
- 桌面采用 Electron + 配套独立 Node 后端；数据在 `%LOCALAPPDATA%\RCC-Desktop-Preview`，与程序、源码及旧安装版分开。重装不覆盖配置和会议库；本次没有迁移旧数据。详见 [桌面开发说明](docs/DESKTOP.md) 与 [桌面验证记录](docs/DESKTOP_VALIDATION.md)。
- 下载 [Releases](https://github.com/JH-Zen/realtime-meeting-assistant/releases) 中的 `RCC-Core-Setup.exe`，安装后运行 `RCC.bat`。
- 核心包自带 Node.js，默认使用模拟模式；真实识别及检索需要另外准备运行环境与模型。
- 当前为未签名预览版，Windows 可能显示来源提示；重装会保留已有 `.env` 配置。

## 从源码开始

需要 Node.js 24+ 和 npm；真实语音识别另需 Python 及模型文件。

```powershell
git clone https://github.com/JH-Zen/realtime-meeting-assistant.git
cd realtime-meeting-assistant
npm ci
Copy-Item .env.example .env
npm run build
node packages/backend/dist/index.js
```

打开 **http://127.0.0.1:8787**，点击「模拟讲解」。默认模式不会识别真实麦克风，也不会调用付费模型。

启动命令应在仓库根目录执行，以正确读取 `.env` 和静态页面路径。

Windows 桌面开发：首次 `npm ci` 后执行 `node node_modules/electron/install.js` 获取 Electron 二进制，然后在仓库根目录运行：

```powershell
npm run dev:desktop
```

此命令按 shared → backend → frontend → desktop 构建并启动自己的窗口；修改后重跑。桌面使用独立开发配置 `%LOCALAPPDATA%\RCC-Desktop-Dev\.env`，不读取源码 `.env`。构建用 `npm run build`，本地打包用 `npm run package:desktop`。

## 接入真实能力

按需修改根目录 `.env`，然后重启后端；完整变量见 [.env.example](.env.example)。

| 能力 | 配置与准备 |
|---|---|
| 语音识别 | `MOCK_STT=false`，下载 sherpa-onnx 流式模型并启动 Python worker |
| 问答、导图与摘要 | `MOCK_LLM=false`，填写 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL` |
| 语义检索 | `MOCK_EMBEDDING=false`，准备 `Xenova/bge-m3`；真实检索阈值可从 `RETRIEVAL_MIN_SCORE=0.75` 起评估 |

语音 worker 在另一个终端启动：

```powershell
python -m pip install -r services/stt-worker/requirements.txt
python services/stt-worker/stt_worker.py --model-dir "models/stt/<模型目录>" --num-threads 4 --decoding-method greedy_search
```

本机已按用户选择准备独立的 **CPU 中英 Zipformer int8**，位置 `D:\Apps\实时会议助手-STT-CPU`，默认 2 线程。先双击其中的 `启动CPU语音服务.bat`，再打开桌面预览使用麦克风。重复安装/启用、来源校验、日志及实测结果见 [STT_CPU.md](docs/STT_CPU.md)。固定文件的真实识别已通过；真实硬件、十分钟真人讲话和准确率仍待验收。

- 本地 STT 和 embedding 不等于全流程离线；使用远程 LLM 时，上下文和问题会发送给配置的服务。
- 请勿提交 `.env`、录音或会话数据库。

## 当前问题

- 固定语音文件已完成桌面原生采集到真实 CPU 识别的端到端测试；真实硬件、权限和十分钟真人识别尚未验收，转写中仍有重复字和英文识别差异。
- 录音开始/结束竞态已有取消与串行清理回归；M2 已补齐结束后复习/提问、按 ID 打开、刷新/重启恢复及历史近期原文上下文，见 [M2 验证](docs/M2_VALIDATION.md)。恢复只读取已保存内容，不补录中断期间的音频。
- 检索索引与导图已有显式限量补建、处理账本和任务记录；新音频链路已有可观测缺口与源时间映射。有限自动恢复、其他模块审计与长时间完整性仍待处理，见 [开发计划](docs/DEVELOPMENT_PLAN.md)。
- 摘要未展示且可能漏早期内容；引用存在长会话解析与来源歧义。
- 模拟暂停、真实 LLM 缺密钥静默回退、配置校验及新源码的浏览器访问边界已修复并有回归；旧浏览器启动/停止脚本仍需修复。
- 新工作台仅为示例原型，尚未接入业务；桌面窗口目前复用现有真实业务页面。
- 真实模型质量与长时间运行待评估，部分验证脚本尚未固化。

问题编号、证据、修复顺序与验收条件见 [下一阶段开发计划](docs/DEVELOPMENT_PLAN.md)。安装器无窗口、交互安装卡住和重装覆盖配置已修复，不再列为待修复问题。

多人/多 agent 接手时先读 [协作与改动记录](docs/agent-logs/README.md)。每位参与者按统一模板维护自己的任务、改动归属、实际验证与交接记录；工作区已有改动不能默认归为新加入者。

## 能力限制

- 单用户、同一时间一场会议；已有最小本机列表，尚无搜索、重命名、删除、说话人分离和原文纠错流程。
- 转写可能出错；导图、摘要和回答需回到原文核对。
- 中文识别准确率、回答忠实度、检索质量和真人长时间采集仍需系统评估。
- 自动测试通过不代表真实模型、浏览器麦克风和安装升级已全部验证。
- 仓库不含模型权重、密钥、运行数据库和预构建安装包。
- 适合本机体验与开发，暂不建议直接部署为公网服务。

## 接下来的开发计划

- **M1：真实采集与基础。** 竞态、模拟暂停、模式/配置、访问边界及采集前检查已实施；真实设备和至少 10 分钟识别仍待验收。
- **M2：会话恢复。** 本轮基础完成：结束后继续提问、会议列表、刷新/重启恢复、历史近期原文与切换隔离；完整管理和真实模型质量仍待后续验证。
- **M3：故障恢复。** 索引/导图显式补建、音频缺口和实时任务记录已实施，继续有限自动恢复与其他模块审计；下一阶段加入本地录音导入解析，复用真实识别链路作反复测试。
- **M4：工作台接入。** 接入新界面、摘要与原文定位，移除无能力支撑的示例。
- **M5：桌面窗口。** 本次已提前完成独立窗口、启动/退出与旁路安装基础；真实硬件、模型、旧数据迁移及完整升级交付仍待验证。
- **M6：质量与交付。** 真实语料评估、长跑、回归与安装验收。

按 [开发计划](docs/DEVELOPMENT_PLAN.md) 的完成条件逐项推进；桌面基础已完成，完整交付仍待完成，其他业务里程碑未被桌面封装代为关闭。

## 开发与验证

```powershell
npm run build -w @rcc/shared
npm run typecheck
npm run lint
npm run build
npm test
```

- 2026-10-22 原业务基线：37 个测试文件、281 项测试通过。桌面新增验证与本轮最终回归结果见 [验证记录](docs/DESKTOP_VALIDATION.md)；类型检查、lint、构建按先构建 shared 的顺序执行。
- 本轮 M1 修复与当前验证结果见 [M1_VALIDATION.md](docs/M1_VALIDATION.md)；未将模拟转写、通道 ready 或虚拟麦克风上传当作真实识别通过。
- M2 新增会议恢复、数据库兼容和前端切换回归；共 45 个测试文件、335 项测试，桌面实际流程与证据入口见 [M2_VALIDATION.md](docs/M2_VALIDATION.md)。
- 桌面自动化：`npm run test:desktop`；安装版：`node tools/verify-desktop.mjs --installer=outputs/desktop-preview/RCC-Desktop-Preview-Setup.exe`。用独立测试数据，不调用付费模型。
- 开发页面：`npm run dev:frontend`，访问 http://127.0.0.1:5173。
- 开发后端：在仓库根运行 `node --import tsx packages/backend/src/index.ts`。
- 浏览器回归：构建后运行 `npm run test:browser`；使用已安装的 Edge 和独立测试数据，验证正式页面、Vite 与访问边界，不下载浏览器或模型。
- 修改 shared 源码后，先运行 `npm run build -w @rcc/shared`。

## 项目结构与文档

```text
packages/shared/       共享类型、协议和图引擎
packages/backend/      录音编排、存储、检索和模型适配
packages/frontend/     字幕、导图和问答界面
packages/desktop/      Electron 窗口、受控桥接、后台生命周期
services/stt-worker/   本地 Python 语音识别服务
tools/                 Windows 打包与安装工具
docs/                  架构、开发过程和第三方依赖记录
```

- 技术栈：TypeScript、React、Fastify、WebSocket、SQLite、sherpa-onnx、ONNX embedding。
- 工程记录：[架构决策](docs/ARCHITECTURE_DECISION.md) · [开发过程](docs/DEVELOPMENT_PROCESS.md) · [选型调查](docs/OPEN_SOURCE_SURVEY.md)。
- 当前计划：[问题清单与开发计划](docs/DEVELOPMENT_PLAN.md)；界面参考：[工作台预览说明](design/meeting-workbench/README.md)。
- 许可证：[MIT](LICENSE)；第三方依赖与模型说明见 [THIRD_PARTY.md](docs/THIRD_PARTY.md)。
- 历史文档保留当时的结论与未覆盖范围；本页提供摘要，当前问题状态与下一阶段验收以开发计划为准。
