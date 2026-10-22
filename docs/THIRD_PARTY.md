# THIRD_PARTY — 第三方组件登记

> 设计文档 §54 Rule 4：新增第三方项目必须登记「项目名 / 来源 / License / 版本 / 作用 / 为什么选择 / 替代方案」。
> 未在此登记的依赖视为未完成。版本与 License 均实测自 npm registry / PyPI / LICENSE 文件（Phase 0–4 为 2026-10-16，第 15、16 条为 Phase 5 的 2026-10-20 实测），非记忆。

## 已决定采用

### 1. sherpa-onnx
- **来源**：https://github.com/k2-fsa/sherpa-onnx
- **License**：**Apache-2.0（代码）+ Apache-2.0（所用 Zipformer 模型权重）**
- **版本**：1.13.8（PyPI，win_amd64 wheel 覆盖 cp37–**cp314**）
- **作用**：实时流式语音转文字，产出 partial / final 识别结果与端点信号
- **接入层级**：**Level 3** —— 独立本地 Python 进程 `services/stt-worker/stt_worker.py`，只调用 sherpa-onnx 的公开 `OnlineRecognizer` API，用 `websockets`（见第 15 条）做传输，Node 作为 WS 客户端连接。**不 fork、不改源码、不重写。**
  - **Phase 5 文档更正**：本条与 `OPEN_SOURCE_SURVEY.md` §1 在 Phase 0 写的是"用其自带的 `sherpa-onnx-online-websocket-server`"，实测**拿不到这个可执行文件**：GitHub release 资产里没有它，本机安装的 `sherpa-onnx==1.13.8` wheel 里 websocket 相关文件为 **0 个**，唯一 console script 是 `sherpa-onnx-cli`（还额外需要 `click`）。接入方式因此从"零二次开发"改为"约 300 行薄 worker"，代价已付、结论不变（仍是 Level 3 本地服务，识别算法一行没自研）。详见 `ARCHITECTURE_DECISION.md` §6.3 D-20。
- **为什么选它**：目标机只有 Intel Iris Xe 核显（无 CUDA）、16GB RAM、无 Docker。它是唯一同时满足①真流式 partial+final ②CPU 实时 ③代码与模型双 Apache-2.0 商用干净 ④有 Python 3.14 Windows wheel ⑤公开 API 稳定、写一层薄 worker 就能接上的方案。
- **延迟证据（分两档，不混用）**：**侦察期（Phase 0）**用 21.3MB 中文小模型 + 单条重复测试音频测得 RTF **0.034–0.037**（27× 实时）、首个 partial **0.73s**，长跑等效 46 分钟音频 RSS 仅增长 68KB 无泄漏。**Phase 5 落地实测**用 511MB 双语模型 int8 权重、`--num-threads 4`：selftest 非定速 RTF greedy **0.1256** / modified_beam_search **0.1677**（仍 6–8× 实时）。**2026-10-20 的 37.1 分钟 1× 定速长跑**（双语模型、同一起参、`pacingOverruns=0`）第一次给出首字延迟分布：首个 partial **n=334 p50 0.936s / p95 1.824s / max 1.974s**——按 §46 的两档读法：**<2s 的最大可接受档 334 条全过但只剩 26ms 余量，<1s 的目标档只有半数达成**（p50 0.936 意味着至少一半在 1s 内，确切比例要等阈值计数补进脚本才有；先前这里写的"尾部超出近一倍"是拿 p95 去比单档 1s，读错了预算），且已是 4 线程 greedy 最快档；同一跑反解出稳态端到端处理仅约 **30–95ms**，因此原先记的"final 迟到 p50 0.95–1.81s"被确认为**收尾样本**而非稳态延迟（推导与证据见 `ARCHITECTURE_DECISION.md` §6.3 D-24）。双语大模型的**中文准确率仍未验证**（语料是官方演示音频循环，对 WER 无意义；登记为 R1 风险）。
- **替代方案及淘汰理由**：`faster-whisper`/`WhisperLiveKit`/`whisper.cpp`（文档化 partial 延迟≈3.3s，**违反 <1s 字幕指标**，且中文 WER 弱于 Paraformer，仅保留为离线高精度重转旁路）；`FunASR paraformer-zh-streaming`（中文更强但 `pip funasr` 为 sdist-only 无 Windows wheel，需 uv 拉 3.11/3.12 + torch，运维成本高，列为中文不达标的升级路径）；`Vosk`（最后 release 2024-04 已停滞，中文 CER≈14%）；`NVIDIA Parakeet/Canary`（**无中文 + Canary-1b 原始权重 CC-BY-NC 禁止商用 + 面向 GPU**）。
- **替换成本**：低。核心只见 `TranscriptSegment`，换 provider 只重写 Adapter。

### 2. Silero VAD
- **来源**：https://github.com/snakers4/silero-vad
- **License**：**MIT（代码与模型均为 MIT）**
- **版本**：v6.2.3
- **作用**：语音活动检测／端点判定
- **接入层级**：**Level 1**（已内建在 sherpa-onnx 的端点检测中，无需单独集成）
- **为什么选它**：≈260k 参数、单 CPU 线程每 30ms 块 <1ms，且已是 sherpa-onnx / faster-whisper / WhisperLiveKit 的默认 VAD；MIT 许可商用无虞。
- **替代方案**：WebRTC VAD（BSD-3，更小更快但精度低，且 `py-webrtcvad` 无 3.14 wheel 已停滞）；FSMN-VAD（Apache-2.0，但仅 Python，绑定 FunASR 生态）。
- **放置决策**：VAD **归后端**，因为端点决定 final 段边界与 MindMap 节点边界，必须与 ASR 流共享同一权威源。浏览器侧的 `@ricky0123/vad-web`（MIT）仅可用于门控上行音频与显示音量条，**不得作为权威**。
- **替换成本**：低。

### 3. React Flow（`@xyflow/react`）
- **来源**：https://github.com/xyflow/xyflow
- **License**：**MIT**
- **版本**：12.12.0（npm 2026-09-24，repo pushed 2026-10-15，38.7k★）
- **作用**：MindMap 的图渲染层（节点/边/拖拽/缩放/折叠/自定义 DOM 节点）
- **接入层级**：**Level 1**（npm 依赖）
- **为什么选它**：本项目最难需求是"加一个节点不许重排整图"。React Flow **没有内置布局引擎**，`position` 完全由调用方提供，因此坐标稳定性**是结构性保证的**，不需要与库的内部布局搏斗。DOM 自定义节点便于承载 title+summary+confidence 卡片；`onlyRenderVisibleElements` + `hidden` 提供长会话性能杠杆；官方推荐 Zustand 与本选型一致。
- **替代方案及淘汰理由**：`Cytoscape.js`（MIT，Canvas 上限更高 ~5000 节点真实数据，亚军；但 React 包装器 2022 年冻结需命令式操作、惯用法"跑 layout"会全排、富 HTML 节点卡片困难、默认观感像网络图不像导图）；`AntV G6 v5`（MIT，Canvas+DOM 节点+`addData` 增量，第三选择；但 v5 刚大重写、335 个 open issue、文档中文优先）；`jsMind`/`Mind Elixir`/`simple-mind-map`/`markmap`（**全部自持模型并在结构变化时重跑整树布局，坐标不稳定，且无法消费我们的 add/move/merge op schema**；另 mind-elixir 的 `latest` 是预发布版、simple-mind-map 的 `latest` 是 hotfix 版）；`mermaid`（静态 text→SVG 整体重绘，非实时交互）；`Konva`/`PixiJS`（坐标自持但零图语义，边/缩放/折叠全要自建）；**`GoJS`（商业 ≈$3,995/开发者，无 key 带水印 → License 阻断）**；**`tldraw`（source-available，LICENSE 明写禁止生产环境 → License 阻断）**。
- **替换成本**：中。它只是视图层；`applyOp` reducer、坐标模型与 `graph_positions` 存储与渲染器无关，故可整体替换为 Canvas 渲染器（这是当初为 R3"未验证节点上限"留的降级阶梯）。**R3 已于 2026-10-20 实测关闭（§6.2 D-26）：1163 节点下缩放/平移/空转共 455 帧，p50/p95/p99 全 17 ms、>50 ms 帧 0 次——这一档"换 Canvas 才扛得住"的假设不成立，阶梯的渲染器迁移那一层已无实测依据。** 同一批数据暴露的是另一件事：每批 `applyOps` 同步只需 4–13 ms，但要 18–362 ms 才上屏。**但"这 0.3 s 是我们的渲染代码造成的"这一判断当晚被自己的实验推翻**（详见 §6.2 的 D-26 同日更正）：V8 CPU profile 显示每批 ≈231 ms 在浏览器非 JS 段、React ≈55 ms、React Flow ≈43 ms、GC ≈30 ms、DOM API ≈18 ms，而我们自己的派生代码只占 4–9 ms；把 `buildFlow` 记忆化后复用率最高 93.9%，上屏延迟没变。**`onlyRenderVisibleElements` 也已实测：它把视口内 DOM 节点从 1163 压到 29，但那 ~229 ms 依旧在。** 所以这两处都**不是**那 0.3 s 的杠杆，真实成因目前记录为"未知、且不在本项目代码里"；默认折叠尚未单独实测。库本身的结论不变：换 Canvas 渲染器既不解决帧率（已达标），也不解决上屏延迟（未归因）。

### 4. d3-hierarchy
- **来源**：https://github.com/d3/d3-hierarchy
- **License**：**ISC**
- **版本**：3.1.2（自 2022-04 稳定）
- **作用**：对**单个子树**做确定性 tidy 布局（`tree`/`cluster`/`radial`）
- **为什么选它**：14KB、完全确定性、同步可调用于每次操作；作为纯函数只对新子树调用再把结果平移使子树根保持原坐标，即可实现"局部整理而不动全图"。
- **替代方案**：`dagre`（**0.8.5 于 2019-12-03 发布后冻结至今**，且 `layout()` 覆写所有节点坐标、无 fixed 概念 → 与增量需求正面冲突）；`d3-force`（力导向天生不稳定，加节点必挤动旧节点，且**不确定**）；`elkjs`（layered 确定性且方向感知，适合树，但见下方 License 风险与体积）。
- **替换成本**：低（纯函数，输入输出即坐标）。

### 5. emittery
- **来源**：https://github.com/sindresorhus/emittery
- **License**：**MIT**（engines ≥22）
- **版本**：2.1.0
- **作用**：模块化单体内部的进程内事件总线
- **为什么选它**：**监听器抛错不会中断其他监听器**（全部执行完毕，错误聚合为 `AggregateError`），这与本项目「一个模块失败不得拖垮系统」的硬要求精确对应；并提供 `events()/anyEvent()` 异步迭代与 AbortSignal 订阅。相较之下 Node 内置 `EventEmitter` 是同步 emit，一个监听器抛错会中断后续，且未处理的 `'error'` 事件**直接让进程崩溃** —— 用零依赖换来自写故障隔离 shim 不值。
- **替代方案**：`EventEmitter`（内置，需自包隔离）；`mitt`（无隔离无异步迭代）；`mqemitter`（MQTT 风格主题，对 4 模块总线过重）；`RxJS`（Apache-2.0，能力强但对本场景是过度设计）。明确**不上** Kafka/RabbitMQ/Redis Streams（设计文档 §17）。
- **替换成本**：低（一层薄 wrapper 定义 `BusEvents` 映射类型）。

### 6. openai（官方 Node SDK，走 OpenAI 兼容端点）
- **来源**：https://github.com/openai/openai-node
- **License**：**Apache-2.0**
- **版本**：7.34.0
- **作用**：调用 LLM（MindMap 图操作、QA 流式回答、Summary 生成），含 Structured Outputs
- **为什么这么用**：DeepSeek / Qwen(DashScope) / GLM(Z.ai) / Kimi 全部提供 OpenAI 兼容 `/v1` → **一个 client + 换 baseURL/model 即完成 Provider Adapter**，接缝天然存在且不需要 provider 抽象框架。MVP 明确只要「1 个正式 + 1 个 mock」（设计文档 §34），自写 ~50 行 `LLMProvider` 接口最省。
- **替代方案及淘汰理由**：`Vercel AI SDK v7`（Apache-2.0；若要 `partialOutputStream` 流式半成品 JSON 或多 provider 统一 usage/retry 再引入；当前承担 v6→v7 API 漂移成本不划算）；`@anthropic-ai/sdk`（MIT，无 `json_schema` strict 参数，只能强制 tool use）；`@google/genai`（Apache-2.0，`responseSchema` 语法约束很可靠，但需专用接缝）；`LiteLLM`（核心 MIT，`enterprise/` 目录商业授权；1 provider 时代理是纯增运维）；`one-api`（**实测 LICENSE 为 MIT**，不需要）；**`new-api`（AGPL-3.0 + 去品牌需商业授权 → License 风险，禁用）**；`LangChain/LangGraph`（MIT 但与「非必要不引入复杂 Agent Framework」正面冲突，社区共识为线性单次流程用属过度设计，且 breaking change 频繁）。
- **替换成本**：低（接口在核心侧，SDK 只在 Adapter 内）。

### 7. Fastify + @fastify/websocket（`ws`）
- **来源**：https://github.com/fastify/fastify
- **License**：**MIT**
- **版本**：Fastify 5.12.7 / `@fastify/websocket` 11.3.4 / `ws` 8.22.0
- **作用**：后端 HTTP + 与浏览器/STT worker 的 WebSocket 通信
- **为什么选它**：Node 主栈下最成熟的 WS + schema 校验 + pino 日志组合；`ws` 比 `uWebSockets.js`（非正常 semver npm 包，需 git 安装）更易在这台 Windows 上装稳。
- **替代方案**：`Hono`（MIT，14KB 且多运行时可移植 —— 但我们锁定 Node，其优势用不上）；`Express`（成熟但 WS 与校验需自拼）。
- **替换成本**：中。

### 8. node:sqlite（Node 内置）
- **来源**：Node.js 标准库（内置 SQLite 3.53.1）
- **License**：Node 绿鸿许可证 / SQLite 公共域
- **版本**：随 Node 24.18.1
- **作用**：全部持久化（sessions / transcript / mindmap / summary / Q&A）
- **为什么选它**：**本机实测** `DatabaseSync` 可用、无需 `--experimental-sqlite` 标志、无运行时警告，FTS5 / JSON1 / `loadExtension()` 均可用，批量写入正常。零安装、**零原生编译** —— 这在 Windows + Node 24 上排除了 `better-sqlite3` 需要 node-gyp/MSVC 或预编译包缺失的经典失败模式（设计文档 §37 决策依据里的"依赖数量"这一项直接归零）。
- **替代方案**：`better-sqlite3`（MIT，API 成熟且快，但 Windows+Node24 需匹配 prebuilt 或 VS Build Tools → 保留为文档化 fallback）；`Drizzle ORM`（Apache-2.0，同时支持两种 driver，想要 ORM 时选它）；`Prisma`（Apache-2.0，但 query engine 二进制 + 迁移工具对单文件本地存储是过度设计 → 不用）。
- **风险**：官方文档仍标 **stability 1.2（实验族）**，预计 Node 26 才 Stable → **已决定封装在单一 repository 模块后**，API 漂移时改一个文件。
- **替换成本**：低（repository 层隔离）。

### 9. Zod
- **来源**：https://github.com/colinhacks/zod
- **License**：**MIT**
- **版本**：4.x
- **作用**：Graph Operation / LLM 结构化输出 / 事件 payload 的运行时校验（对应设计文档 §20「Schema Validation」这一必经环节）
- **为什么**：LLM 输出合法性是本项目的承重风险（R2），必须在运行时校验且可做 repair 反馈；TS 静态类型与运行时校验同源。
- **替代方案**：JSON Schema + Ajv（更通用但 TS 类型推导要额外 codegen）。
- **替换成本**：低。

### 10. Zustand
- **来源**：https://github.com/pmndrs/zustand
- **License**：**MIT**
- **版本**：5.x
- **作用**：前端状态（含 `positions` / `pinned` / `collapsed` 等布局状态）
- **为什么**：React Flow 官方推荐 store 模式；且布局状态需要**在组件外**被纯 reducer 更新（`applyOp`），Zustand 的命令式 `set` 与选择器订阅正好契合，避免 Context 重渲染风暴。
- **替代方案**：Redux Toolkit（对本项目状态形状偏重）、Jotai（原子化模型与图 reducer 不太贴合）。
- **替换成本**：中。

### 11. React + TypeScript + Vite
- **来源**：官方
- **License**：**MIT**
- **作用**：前端基座
- **为什么**：设计文档 §36 的建议组合，且未发现更优替代；React Flow 需要 React。
- **替代方案**：Next.js（本项目是本地单用户工具型应用，不需要 SSR/路由/服务端能力，Vite 更轻）。

### 12. Biome
- **来源**：https://github.com/biomejs/biome
- **License**：**Apache-2.0（软件）+ MIT（第三方组件）**
- **版本**：2.5.15（npm，平台二进制经 `optionalDependencies` 分发，**本次安装未触发任何 install script**）
- **作用**：§54 Rule 8 的 lint 关卡（`npm run lint` / `npm run check`），规则集用官方 `recommended` preset，含 a11y（`useButtonType`）与 React Hooks 依赖检查
- **为什么选它**：**本仓库用的是 TypeScript 7.0.2，而 `typescript-eslint@8.71.2` 的 peer 范围是 `>=4.8.4 <6.1.0` —— 装不上**。Biome 自带解析器，不依赖 tsc 的编译器 API，因此与 TS 版本解耦；单二进制、无插件装配、一次 `biome migrate` 即可跟进配置 schema。
- **替代方案及淘汰理由**：`typescript-eslint`（**被 TS 7 的 peer 范围硬阻断**，用 `--legacy-peer-deps` 强装等于把 lint 建立在未验证的编译器 API 上）；`oxlint`（MIT，同样解耦，但 postinstall 需下载二进制，在本机的 install-script 审批策略下多一道人工步骤）；`ESLint` 核心（MIT，但仍需一个 TS parser，绕回同一个冲突）。
- **首次运行结果**：56 个文件，修出 3 处真实的死代码（`MindMapAgent` 从未使用的 `transcript` 依赖、`RecordingController` 从未使用的 `config` 依赖、`SessionRuntime` 只作构造参数却声明成字段）、2 个只抛不产的伪 generator、1 个未使用变量、10 个缺 `type="button"` 的按钮；另有 2 处 `useEffect` 依赖被显式标注为「触发器而非读取值」并写了理由。
- **替换成本**：低（只有一份配置文件与两个 npm script）。

### 13. @huggingface/transformers（ONNX 推理运行时）
- **来源**：https://github.com/huggingface/transformers.js
- **License**：**Apache-2.0**（实测 `node_modules/@huggingface/transformers/package.json`，4.3.1）；其推理后端 `onnxruntime-node@1.30.0` 为 **MIT**，`@huggingface/tokenizers@0.2.0` Apache-2.0，`protobufjs@7.6.6` BSD-3-Clause，`sharp@0.35.5` Apache-2.0。**依赖树无 GPL/AGPL/NC。**
- **版本**：4.3.1（npm，2026-10-17 安装实测）
- **作用**：Level 1 npm 依赖 —— 只在 `packages/backend/src/retrieval/embeddingWorker.ts` 这一个文件里被调用，把 §30 的 `EmbeddingProvider` 缝接到本地 ONNX 模型；核心检索代码对它零感知。
- **接入层级**：**Level 1 + `worker_threads`**（同一 OS 进程内的独立线程，不是独立服务，Rule 6 未被突破，见 §9.2 D-12 的实测依据）。
- **为什么选它**：目标机是无 CUDA 的 Iris Xe 核显 + 16GB RAM，需要在 Node 进程内直接跑 embedding，而它是唯一"npm 装上就带 CPU 二进制、不需要 Python、不需要外部服务"的方案。**关键否决点已被实测排除**：`onnxruntime-node` 的平台二进制随 npm 包分发，本机三个 install script（`onnxruntime-node@1.30.0`、`protobufjs@7.6.6`、`esbuild@0.28.2`）被审批策略拦下后，导入与推理仍完整可用 —— 因此不需要放行任何 install script。
- **实测性能**（`Xenova/bge-m3` q8，权重已在本地缓存，见第 14 条）：模型冷加载 4.9–5.4 s（4 次独立进程实测，故 boot 时 `prewarm()` 异步预热，绝不落在第一个提问上）；单条 embedding 端到端 46–93 ms（`metric:embedding_batch`）；查询侧含扫库共 50–62 ms（`metric:retrieval_search`）。**推理期间字幕投递延迟相对各自排定时间戳：基线 2 ms、p95 +3 ms、最大 +4 ms**（同一条 mock 脚本、同一 timer 节奏，只有主 loop 被侵占才会推高这个数），对照线程内直跑时主 loop p99 404 ms —— 这就是不拆进程也不卡字幕的证据。
- **替代方案及淘汰理由**：`sherpa-onnx`（也提供 ONNX embedding，但会把第二块能力塞进已经存在的 Python 进程，而 §54 Rule 2 要求"本地服务 < 轻量 Adapter"，Node 内置方案更轻）；`sentence-transformers`/Python FastAPI embedding 服务（**为单个函数调用新增一个跨进程服务，违反 Rule 2/Rule 6 与"无证据不拆服务"**）；`ollama` / 任何外部推理服务（引入用户不必装的外部依赖，且 §30 要求向量与元数据同库同进程可离线）；`node-vlq`/`ort` 裸用 ONNX Runtime（要自己写 BERT 前处理、mean-pooling 与 L2 归一，等于自研已在成熟库里有的部分，违反 Rule 1 的"成熟库 > 自研"）；`sqlite-vec`（见下一节，是索引问题不是推理问题）。
- **替换成本**：低。整个运行时被 `EmbeddingProvider` 接口包住，换运行时只换 worker 文件；`RetrievalCore`、存储与 QA 不变（这条已被 Phase 7b/7c 的 Mock→真实切换实际验证过一次）。

### 14. Xenova/bge-m3（embedding 模型权重）
- **来源**：https://huggingface.co/BAAI/bge-m3（原始），推理用社区 ONNX 量化版 https://huggingface.co/Xenova/bge-m3
- **License**：**MIT（权重，代码与权重分别核对）** —— 这是把它选为默认模型的首要理由：原始 bge-m3 已是 MIT，Xenova 转换版同样 MIT，商用无附加条件。
- **版本 / 体积**：q8 量化 ONNX，本地缓存实测 560 MB（`models/embedding/Xenova/bge-m3/onnx/model_quantized.onnx` + tokenizer），向量维度 **1024**。
- **作用**：§30 检索与 §31 记忆块的向量化；`EMBED_MODEL` / `EMBED_DTYPE` / `EMBED_DIM` 可换。
- **实际下载渠道（必须登记，Rule 4）**：本机 `huggingface.co` **不可达**（000，15 s 超时），`hf-mirror.com` 可达（200，2.16 s），`modelscope.cn` 可达（200，0.55 s）。因此 `EMBED_REMOTE_HOST` 默认 `https://hf-mirror.com/`，且 `remotePathTemplate` 保持 `{model}/resolve/{revision}/`。
- **为什么选它**：在候选里语义质量实测最高，尤其跨语种——"中文提问命中英文表述"这类场景是讲座问答的常态。本机实测（同一段中英混合语料，余弦相似度）：bge-m3 相关对 **0.9129**，`Xenova/bge-base-zh-v1.5` 只有 **0.6779**。代价登记在 §9.2 D-13：体积 5.7 倍（560 MB vs 99 MB）、首 token 更慢，且它的**绝对分数整体偏高**（无关句也能到 0.6），所以 `RETRIEVAL_MIN_SCORE` 必须按实测分布校准而不是沿用 mock 的 0.1。
- **实测分数分布（用于校准阈值，`RETRIEVAL_MIN_SCORE=0.75` 的由来）**：真实会话索引 6 条、3 类提问——命中目标句 **0.957**；同主题干扰句 **0.711–0.771**；完全离题提问最高仅 **0.662**。故 0.75 能留住"真正的答案句"、丢掉离题噪声，实测 Test D 在 0.75 下仍正确引用 `[00:20]`。
- **替代方案及淘汰理由**：`BAAI/bge-base-zh-v1.5`（MIT，亚军；快且小，但跨语种实测 0.6779 明显不够）；**`jina-embeddings-v3`（CC-BY-NC-4.0，非商用 → 直接阻断，见 License 风险登记表）**；`text-embedding-*` 云端 API（违反 §30 本地化与"无外传"约束，且需要 key）；`gte-Qwen2-1.5B-instruct`（**Qwen 权重为 tongyi 定制许可，非 OSI**，且 3 GB 级体积在核显机器上不现实）。
- **替换成本**：低，但**换模型必须重嵌**：向量行的身份含 `provider`+`dim`，旧模型的行在新查询里被直接过滤掉（§9.2 D-9）。因此换模型后索引会自然退化成"只有新数据可检索"，这一点必须让 UI 知情，不能假装兼容。

### 15. websockets（Python，STT worker 的传输层）
- **来源**：https://github.com/python-websockets/websockets
- **License**：**BSD-3-Clause** —— 实测自已安装包的 `websockets-17.3.dist-info/licenses/LICENSE`（PyPI 元数据的 License 字段为空，不能据此下结论）。
- **版本**：17.3（PyPI wheel，装在 `services/stt-worker` 的独立 Python 3.14 环境；`requirements.txt` 已钉版本）
- **作用**：只承担 Phase 5 本地 STT worker 的 WebSocket 服务端传输（收 PCM 二进制帧、发 JSON 结果帧）。识别本身、端点判定、时钟计算都在 sherpa-onnx 与本仓库 worker 代码里，`websockets` 不含任何业务逻辑。
- **接入层级**：**Level 2（本地服务内部依赖）** —— 它是 worker 进程的依赖，不进入 Node 侧，也不进入核心类型系统。Node 侧的 WS 客户端是已在册的 `ws`（第 7 条）。
- **为什么选它**：Python 生态里唯一同时具备①维护活跃 ②BSD 许可商用无虞 ③纯 asyncio、无原生编译依赖（对比 `py-webrtcvad` 那样卡 wheel 的包）④ sherpa-onnx 官方 Python websocket 示例本身就依赖它 —— 即"跟着上游用法走"的传输层。
- **替代方案及淘汰理由**：`aiohttp`（Apache-2.0，但为完整 HTTP 框架，我们只需要 WS 服务端，引入它等于多装一整个 Web 栈）；`FastAPI + uvicorn`（同上，且要为 worker 增加 ASGI 这层不存在的抽象）；`pyzmq`（BSD-3，但换成 ZMQ 就丢掉了"浏览器/Node 都能直连 ws://"的调试能力）；`socket` 手写协议（违反 Rule 1 的"成熟库 > 自研"）。
- **替换成本**：低。协议 v1 与传输无关，换传输只改 worker 里的收发循环。

### 16. sherpa-onnx 流式 Zipformer 双语模型（STT 权重）
- **来源**：本地目录 `.probe-model/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20`，从 `OPEN_SOURCE_SURVEY.md` §1.1 登记的 GitHub release 资产清单（https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models）下载。目录内 `README.md` 记录了它的上游：torchscript 权重 https://huggingface.co/pfluo/k2fsa-zipformer-chinese-english-mixed，训练代码 icefall `pruned_transducer_stateless7_streaming`。
- **License**：**Apache-2.0（权重）** —— 就地实测：目录内 `README.md` 的 front-matter 明写 `license: apache-2.0`。代码 Apache-2.0 + 权重 Apache-2.0，商用路线干净（Rule 4 要求权重单独核对，故单列此条）。
- **版本 / 体积**：整目录 531MB（含 fp32 与 int8 两套权重）。worker 的 `--model-dir` 按 sherpa-onnx 命名约定自动挑选，**int8 优先**：encoder 181.9MB + decoder 13.1MB + joiner 3.2MB ≈ **198MB**，这是 Phase 5 实测 RTF 0.126/0.168 所用的组合。
- **作用**：Phase 5 真实流式识别的默认模型（中英双语），启动命令 `python services/stt-worker/stt_worker.py --model-dir <本目录>`。
- **为什么选它**：双语（讲座里中英术语混用是常态，单语模型会把英文读成乱码），且在下载量清单里是"最久经考验"的一档（670,159 次）。选它付出的代价是延迟余量从 27× 实时降到 6–8×，仍有充分空间。
- **替代方案**：`streaming-zipformer-small-ctc-zh-int8-2025-04-01`（21.3MB，本机 Phase 0 基准用它测得 RTF 0.034–0.037；**但该目录里没有 README，权重许可未能就地核对**，所以只作为基准与降级候选，不作为默认交付）；`streaming-zipformer-zh-int8-2025-06-30`（132.6MB，中文单语）；`streaming-paraformer-bilingual-zh-en`（1.05GB，中文更强但体积翻倍）。
- **替换成本**：低。换模型只换 `--model-dir`，worker 与 Node 侧代码不变；但**换模型必须重跑中文准确率验证**，因为它决定 §14 字幕质量与 MindMap 分段质量（风险 R1）。

## 交付期新增：再分发的运行时与构建期系统组件（2026-10-22，架构决策 §6.5 D-36）

### 17. Node.js 运行时二进制（安装目录自带的 `runtime\node.exe`）
- **来源**：https://nodejs.org 的 Windows x64 官方二进制；本机实测被拷贝的那一枚在 `D:\Enviroment Configuration\node.js\node.exe`。
- **License**：**MIT**（Node.js 项目口径，`node.exe` 内还捆 OpenSSL 等组件，其声明集中在上游 `LICENSE` 文件里）。**本条有一格没做到，必须写在这里而不是含糊过去**：本机这枚 `node.exe` 旁边**没有 LICENSE 文件**（实测同目录只有 `corepack`/`npm`/`npx`/`node.exe` 等，`LICENSE`、`LICENSE.txt` 均不存在），而 `tools/package.mjs` 只拷贝 `process.execPath` 本身，所以现在的安装包是"再分发二进制"而**未内嵌其许可声明全文**。MIT 的条件正是"在作品的全部副本中包含此许可声明"，因此在把安装包交给任何人之前，应把上游 `LICENSE` 文本放进安装目录的 `runtime\`（本机离线取不到，需要一次网络获取；这一格已作为交付前置待办登记，不是已完成）。
- **版本**：**v24.18.1** —— 实测而非记录：脚本从 `process.execPath` 取二进制、从 `process.version` 取版本号，两者同一个进程，所以"打包用的 node"与"登记下来的版本"不可能是两个东西。
- **作用**：安装目录里唯一的可执行宿主。`RCC.bat` / `RCC-stop.bat` / `RCC-modules.bat` 都以 `%ROOT%runtime\node.exe` 为首选，只有它不存在时才回落 `PATH` 上的 `node`。它不含任何业务逻辑，也不进类型系统。
- **接入层级**：**Level 3（交付物自带的运行时）** —— 与产品依赖树无关，`package.json` 因为这次交付一个字节没变。
- **为什么选它**：目标机不应假设装了 Node（这是要双击使用的本地应用），而依赖树里带原生二进制的 `onnxruntime-node@1.30.0`（第 13 条）只认官方 Node 的 ABI；自带 node.exe 是让"装完就能跑"成立的唯一形状，且它同时是 §54 Rule 3"用户不需要装任何东西"的落地方式。
- **替代方案及淘汰理由**：让用户自装 Node（把安装体验变成前置条件，且用户那边的版本会直接改变原生依赖的可用性——正是本项目在 D-31 之后反复用控制组防的那类"环境差异伪装成功能问题"）；`node --experimental-sea-config`（single executable application，要 postject 步骤、换 node 版本就得重做，收益只是"少一个目录"，且崩溃时的路径可读性变差）；`pkg`（同类，且上游已进入维护停滞）；Bun（Rule 4 意义上的代价最大：整棵依赖树要重新核对，npm 与原生包的兼容矩阵不是本项目能背书的东西）。
- **替换成本**：低——`runtime\node.exe` 只被那三个 `.bat` 引用；但换的是整个安装形态的宿主，验收下限是重跑 launcher 链（`.scratch/live-launcher.mjs`，8 条）与两次安装态真装真跑。

### 交付期用到的系统自带组件（不构成"新增第三方项目"，登记是为了可追溯）
这三个都在构建机上使用，**不随包分发、不进产品依赖**，因此不属于 §54 Rule 4 的登记义务范围；登记在此只回答一个问题：**这台机器上那个 `Setup.exe` 到底是用什么造出来的**。
- **`C:\Windows\System32\tar.exe`（bsdtar / libarchive，BSD-2-Clause）** —— 构建期把暂存目录压成 `payload.zip`（`tools/make-installer.mjs`）。**目标机不需要它**：解压走 .NET 自带的 zip 实现。
- **`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`（.NET Framework 4 自带编译器，随 Windows 提供）** —— 编译 `tools/installer/Setup.cs`，并把 `payload.zip` 与 UTF-8 manifest 作为托管资源内嵌，产出单个 `Setup.exe`。是 IExpress 被逐条证否之后的替代路线（§6.5 D-36 有那份构型矩阵）。两个直接后果：它是 pre-Roslyn 的 csc，**只接受 C# 5 / .NET 4.0 语法**；产出的 exe 需要目标机有 **.NET Framework 4.5+**（`System.IO.Compression` 从 GAC 解析），Windows 10/11 自带。
- **`C:\Windows\System32\makecab.exe`（随 Windows 提供）** —— 只在 IExpress 路线的调查里出现：实测它被 `iexpress` 调用但中间柜从未生成，手工调用它自己则成功。**当前构建链不再使用它**，登记是为了让那次证否可复现。
- 另需登记一条与"分发"有关的实测卫生：**npm 在本机会拦 postinstall**（实测 `protobufjs@7.6.6`、`onnxruntime-node@1.30.0`、`esbuild@0.28.2` 三个 install script 被审批策略拦下，导入与推理照旧可用，见第 13 条）。因此 `tools/package.mjs` 的口径是不联网、不跑 install 脚本、只走安装态的树——**任何"装完再 build 一下"的交付假设在这台机器上已经实测不成立**。

## 检索侧（Phase 7）：已评估未采用


- **sqlite-vec 0.1.9（`MIT OR Apache-2.0`）** —— 满足设计文档 §30 字面的"SQLite + 本地向量扩展"，但**未采用**：要按平台分发并加载原生扩展二进制（pre-1.0），而 `ARCHITECTURE_DECISION.md` §9.2 D-6 的实测表明 1024×3000 的暴力扫只有 ~68ms，没到需要 ANN 的量级。采用条件同那条决策：行数 > 3000 或查询 p50 > 100ms。
- **FAISS / 任意独立向量库** —— 直接排除，违 §30"向量与元数据同库"与 Rule 1。
- **jina-embeddings-v3** —— **CC-BY-NC-4.0，非商用授权，商用路线上直接禁用**（§10 License 风险登记表已列）。

Phase 7a–7c 的向量编解码、Top-K 排序、摄取队列全部是自有代码 + 已在册的 `node:sqlite`，**零新 npm 依赖**，所以本节没有新增条目。Phase 7d 接入真实模型时新增的第 13、14 两条已登记在上文"已决定采用"；Phase 5 接入真实 STT 时新增的第 15、16 两条同理（worker 的传输层与 STT 权重）。交付形态定稿（§6.5 D-36）新增的是第 17 条（安装目录自带的 `node.exe`）与"系统自带组件"一节：**产品依赖树本身仍然零新增**，`package.json` 与 `requirements.txt` 因这次交付一个字节没变。
