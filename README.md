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
- 可切换模拟/真实 STT、LLM 和 embedding，提供调试面板及 Windows 打包脚本。

## Windows 安装包

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

- 本地 STT 和 embedding 不等于全流程离线；使用远程 LLM 时，上下文和问题会发送给配置的服务。
- 请勿提交 `.env`、录音或会话数据库。

## 当前问题

- 开始与结束录音存在竞态，迟到的连接可能让旧任务重新挂起。
- 结束后不能直接继续提问；刷新、关闭历史时可能出现内容与状态不一致。
- 导入历史未恢复近期原文窗口，检索不可用时的问答回退不完整。
- 导图、索引失败批次缺少补建机制，可能遗漏派生内容。
- 断线会丢音频；缺口和时间偏移尚未完整呈现。
- 引用未验证回答是否受原文支持；100 分钟以上标签存在解析缺陷。
- 阶段摘要尚不可见，整体摘要选择可能遗漏较早内容。
- 模拟模式暂停后仍产生转写；缺少密钥时 LLM 仍可能回落模拟模式。
- API/WS 缺少访问凭证和严格来源校验；部分配置缺少范围校验。
- 前端端口固定为 8787；安装包尚未签名，退出流程仍需完善。
- 部分历史验证脚本仅存于临时目录，无法随仓库完整复现。

## 能力限制

- 单会话原型，尚无说话人分离、完整会话管理和原文纠错流程。
- 转写可能出错；导图、摘要和回答需回到原文核对。
- 中文识别准确率、回答忠实度、检索质量和真人长时间采集仍需系统评估。
- 自动测试通过不代表真实模型、浏览器麦克风和安装升级已全部验证。
- 仓库不含模型权重、密钥、运行数据库和预构建安装包。
- 适合本机体验与开发，暂不建议直接部署为公网服务。

## 接下来的开发计划

- **P1：访问与状态。** 补齐来源/凭证校验，修复录音生命周期，结束后保留复习和提问入口。
- **P1：恢复与完整性。** 恢复历史原文窗口，增加失败任务补建、断线缺口记录。
- **P2：可追溯体验。** 引用跳转原文，展示阶段摘要，修复长会话引用和摘要覆盖。
- **P2：交付与验证。** 统一配置和模拟行为，升级保留用户设置，固化复核脚本与真实语料评估。

## 开发与验证

```powershell
npm run typecheck
npm run lint
npm run build
npm test
```

- 2026-10-22 本地验证：37 个测试文件、281 项测试通过；类型检查、代码检查和构建通过。
- 开发页面：`npm run dev:frontend`，访问 http://127.0.0.1:5173。
- 开发后端：在仓库根运行 `node --import tsx packages/backend/src/index.ts`。
- 修改 shared 源码后，先运行 `npm run build -w @rcc/shared`。

## 项目结构与文档

```text
packages/shared/       共享类型、协议和图引擎
packages/backend/      录音编排、存储、检索和模型适配
packages/frontend/     字幕、导图和问答界面
services/stt-worker/   本地 Python 语音识别服务
tools/                 Windows 打包与安装工具
docs/                  架构、开发过程和第三方依赖记录
```

- 技术栈：TypeScript、React、Fastify、WebSocket、SQLite、sherpa-onnx、ONNX embedding。
- 工程记录：[架构决策](docs/ARCHITECTURE_DECISION.md) · [开发过程](docs/DEVELOPMENT_PROCESS.md) · [选型调查](docs/OPEN_SOURCE_SURVEY.md)。
- 许可证：[MIT](LICENSE)；第三方依赖与模型说明见 [THIRD_PARTY.md](docs/THIRD_PARTY.md)。
- 历史文档保留当时的结论与未覆盖范围，当前问题以本页清单为准。
