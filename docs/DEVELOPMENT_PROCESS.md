# DEVELOPMENT_PROCESS — 开发过程说明

> 这份文件回答三个问题：**现在这套东西是怎么组成的**（架构）、**它是一路怎么长成这样的**（版本 × 每版加了什么 × 每版遇到什么问题）、**哪些结论是靠哪一次实测站住的**（判据与未覆盖）。
> 它是设计文档 §55 要求的 `DEVELOPMENT.md` 那一格的实际载体（文件名不同，作用一致）。
>
> 四份文档各管一件事，不要混着读：
>
> | 文件 | 管什么 | 不该在这里找什么 |
> |---|---|---|
> | `OPEN_SOURCE_SURVEY.md` | Phase 0 的选型侦察与当时的一手测量 | 之后的更正（不少已被推翻） |
> | `ARCHITECTURE_DECISION.md` | 决策记录 D-1…D-36，每条含「决定 / 理由 / 被否方案 / 实测锚点」 | 顺滑的结论（这里刻意保留"当时判到哪一步"） |
> | `THIRD_PARTY.md` | 每一个第三方与再分发物的 License 台账（Rule 4） | 架构理由 |
> | 本文件 | 时间线、架构总览、验证方法学、交付边界 | 新的决策（新决策只进 ADR） |
>
> **一份重要的前提**：本项目所有工程约束来自一份 2436 行的中文设计文档，它**只存在于最初的对话里，仓库中没有副本**。因此 Rule 1–8、§56 的六条验收、§58 的自主推进授权，都无法从代码或提交历史反推——本文件与 ADR 是那份规范的**推导产物**，不是规范原文。

---

## 1. 应用架构

### 1.1 三个进程，一个模块化单体后端

```
P1 浏览器（React 19 + Zustand + React Flow）
   AudioWorklet 16 kHz PCM ──WS 二进制──► P2
   字幕 / 导图 / 问答 UI  ◄──WS 事件──  P2

P2 Node 主应用（唯一有状态的编排者；模块化单体，不是微服务）
   ├ 录音入口 → STT Adapter（WS 客户端）──localhost WS──► P3
   ├ Transcript Core（唯一事实源）+ node:sqlite + emittery 进程内总线
   ├ MindMap Agent / Memory Agent / Context Manager / QA Agent
   └ Embedding worker（worker_threads，同进程不同线程）
        │
P3 Python STT worker（services/stt-worker/stt_worker.py，356 行）
   sherpa-onnx OnlineRecognizer + websockets，零业务逻辑
```

进程边界的唯一理由是故障隔离与运行时约束：sherpa-onnx 只有 Python/onnxruntime 这条路，而原生模块段错误会带走整个进程。除 P2↔P3 之外一律同进程（Rule 2/Rule 6：建议拆服务必须先证明"为什么同进程做不到"）。embedding 曾按这条写成"必须 `child_process`"，后被 §9.2 D-12 的对照实测修正为 `worker_threads`——它消除了 1881 ms 的主循环侵占，又不新增服务，代价（原生崩溃仍连坐）如实记在 D-12。

### 1.2 代码分布

| 位置 | 内容 | 规模（实测） |
|---|---|---|
| `packages/shared/src` | Canonical Schema、Graph Operation、纯 reducer `applyOperation`、事件类型、wire 协议、会话导出文档契约 | 7 个源文件 / 3 个测试文件 |
| `packages/backend/src` | 总线、配置、图存储、三个 Adapter、MindMap/Memory/QA/Transcript 核心、SQLite repository、API/WS/静态伺服、可观测性 | 43 个源文件 / 27 个测试文件 |
| `packages/frontend/src` | 六个组件、音频采集、WS 连接与派发、两个 store、布局、开发用种子 | 18 个源文件 / 7 个测试文件 |
| `services/stt-worker` | Python worker + 钉版本的 `requirements.txt` | 356 行 |
| `tools/` | 打包 staging（`package.mjs` 510 行）、安装壳生成（`make-installer.mjs` 154 行）、内嵌的 `installer/Setup.cs` 196 行 | 交付专用 |
| `.scratch/` | 测量台：73 个 `.mjs` 探针脚本、浏览器级 CDP 驱动、长跑与安装态验收 | **不进仓库**（`.gitignore`） |

前后端共享同一份类型与同一个 reducer：前端应用 WS 帧走的仍是 `applyOperation`，所以"闸门在服务端、渲染在前端"不是两套语义（ADR §7）。

### 1.3 数据流与延迟预算

```
Mic → AudioWorklet(f32/48k) → 降采样 16k → Int16 PCM 100 ms 帧
    → WS 二进制 → P2 → STT Adapter → P3
P3 partial ─► Transcript Core(partial) ─► transcript.partial ─► 只进字幕 UI（内存 ring buffer）
P3 final   ─► Transcript Core(final)   ─► transcript.final
                                          ├─► SQLite + Embedding 队列
                                          ├─► MindMap buffer（≥6 段或 25 s 触发；窗口 45 s）
                                          └─► Memory buffer（语音时间累计 3–5 分钟触发 SummaryBlock）
提问 → Context Snapshot（冻结）→ QA Agent → LLM 流式 → 分块回 UI（带 [mm:ss] 引用）
```

预算都有数：字幕 partial 按 §46 的两档读（目标 <1 s、最大可接受 <2 s），511 MB 双语模型 37 分钟 1× 定速长跑 n=334，首个 partial **p50 0.936 / p95 1.824 / max 1.974 s**——最大档全数达成但只剩 26 ms，目标档只有半数达成。QA 首 token <3 s 是 provider 约束（开着思考的同类调用实测 27–106 s，而 `LLM_TIMEOUT_MS` 默认 30 s，所以 `LLM_DISABLE_THINKING` 默认 `true`）。MindMap 15–30 s 一批，**稳定性优先于即时性**。音频路径只有两跳，任何模块禁止在上面同步等 LLM。

### 1.4 Transcript 是唯一事实源

`partial` 的四条禁令实现为**类型层 + 存储层双闸门**：`TranscriptStore.append()` 只接受 `type:"final"`，partial 走独立内存 ring buffer 给字幕，不入库、不喂 MindMap、不喂 Memory、不建 embedding、不触发总结。这条约束是"字幕会抖动但下游永远稳定"的根因，也是 Test F 里"365 = 365 = 365 = 365"这类逐数核对的依据。

### 1.5 图操作与四道闸

写入链固定：`LLM raw → JSON parse → Zod 校验 → Graph Engine（纯 reducer）→ Graph Store → UI`。禁止整树重生成，只有六种增量操作（`add_node` / `update_node` / `move_node` / `merge_node` / `delete_node` / `add_edge`）。校验分两层（ADR §7）：

| 层 | Schema | 失败处置 |
|---|---|---|
| 模型输出（LLM-facing） | `GraphOperationInputSchema`：按 `type` 判别的 union，`opId` **可选** | repair **最多 1 次**（把 Zod issue 追加回同一 prompt）；仍失败 → 丢弃本批 + `module.error` |
| 系统内部（权威写入） | `GraphOperationSchema`：`opId` 必填 + `stampedAt` | 语义闸门 `orphan_parent` / `unknown_node` / `duplicate_op` / `duplicate_node_id` / `self_relation` / `cycle` → discard + log，**绝不抛穿进程** |

四道闸与 provider 无关，必须存在：孤儿进 orphan buffer 等批内重试（模型不保证先说父亲再说孩子）、环拒绝、`opId` 幂等丢弃、`updatedAt` 单调丢晚到的旧 op。`MAX_REPAIR_ATTEMPTS=1` 与传输重试**刻意解耦**——否则默认配置下 3×3=9 个请求全程持着 single-flight 锁，正是 Test F 禁止的"AI 请求堆积"。

### 1.6 事件总线与隔离七条

选 emittery 的决定性理由：监听器抛错不中断其他监听器（错误聚合为 `AggregateError`），而 Node 内置 `EventEmitter` 同步 emit，一个抛错中断后续且未处理的 `'error'` 直接崩进程。隔离七条是写进代码规范的硬约束（ADR §6），其中两条最容易漏：

- **入口必须有配额**：任何能被客户端反复触发的 AI 路径必须在做昂贵工作**之前**拒绝，且拒绝要落到该请求自己的事件（`answer.rejected`）而不是全局错误通道。
- **失败路径不得重新占用刚释放的工作**：调模型**之前**就把批次从缓冲区分出去，失败后靠重新计时而非"缓冲还满着所以再来一次"，否则模型一挂就是热循环。

Test E 的保护不变量不是靠"kill 开关"实现的（产品里没有也不该有这个开关），而是上面两条 + 每个订阅自带 try/catch。验收方式是**注入真故障**（provider 抛错、监听器抛错、真实 adapter 指向没人监听的端口），不是检查源码里有没有 catch。

### 1.7 存储

十张表，schema 的唯一真相是 `store/sqlite.ts` 的 `SCHEMA` 常量（ADR §11 只是抄它，且曾被实测纠正过一次）。要点：所有表的主键都是 `(session_id, …)` 复合形状；`partial` 不落库；时间单位是"会话内秒"（REAL）而非毫秒；`summary_blocks` 与 `graph_operations` 是 append-only（repository 没有 update/delete 方法，历史摘要在类型层就不可能被改写）；`graph_positions` **只存用户拖拽**，自动布局不入库；`embeddings` 的行身份含 `provider` + `dim`，换模型后旧向量被直接过滤掉（所以换模型必须重嵌，UI 要知情）。后加的列靠 `ensureColumn()`（查 `PRAGMA table_info` 后 `ALTER TABLE`）幂等补齐——开发机上"永远用新库"的假设正是掩盖这类问题的地方。

### 1.8 上下文三层与检索

一次提问的上下文 = **Hot Context**（默认 240 s 语音窗口的原文）+ **检索命中的历史行**（向量 Top-K，`RETRIEVAL_MIN_SCORE` 过滤）+ **阶段摘要**（分层 merge 的概览）+ **导图节点**，提交时冻结成不可变 `ContextSnapshot`。检索仍是暴力 cosine（1024×3000 实测约 68 ms，据此写下复评阈值：行数 >3000 或 p50 >100 ms 才评估 ANN）；`provider`+`dim` 双过滤，两种向量空间绝不混排（"那不是噪声，是自信的错误答案"）；检索失败只降级回答，`inFlight` 的加减必须平衡，否则索引一坏两次未完成请求就把 QA 永久锁死成"全部拒绝"。

阈值是按实测分布校准的：mock 的 0.1 只是词法下界，bge-m3 真实语料里答案行 0.87–0.96、同题干扰 0.71–0.77、**完全离题也有 0.66**，所以真跑要抬到 0.75。`RETRIEVAL_MIN_SCORE` 的默认值仍是 0.1（因为出厂档位是 Mock），但 `.env.example` 第 61–62 行把这件事写在键的正上方，而安装包的 `.env` 就是它生成的副本。

### 1.9 三个 Adapter（Rule 3 / Rule 5）

`STTProvider`（Mock / Sherpa）、`LLMProvider`（Mock / OpenAI 兼容）、`EmbeddingProvider`（Mock / ONNX worker）。第三方 payload 永不越过 Adapter 进入核心，因此每一次"Mock → 真实"切换都只换一个文件：Phase 7b→7d 换 embedding、Phase 5a→5b 换 STT、Phase 10 换 LLM。这条纪律的代价是被实测反过来兑现过一次——`MOCK_STT=true` 时按麦克风得到的不是脚本重播，而是 `module.error{code:"mock_mode_active"}`：**静默替代是被禁止的**，否则每条实测数字都不知道自己属于哪一档。

### 1.10 前端渲染与布局

决定性洞察：**React Flow 没有内置布局引擎**，`position` 必须由调用方提供。于是"加一个节点不许重排整图"是**结构性成立**，而不是需要跟库搏斗——这是它击败 jsMind / mind-elixir / simple-mind-map / markmap 的根本原因。落地方式是内容（`nodes`/`childOrder`/`edges`，纯 reducer 产物）与布局（`positions` + `pinned` + `collapsed`）分离，`layoutGraph` 对**每棵顶层树**取锚点（`pinned[root] ?? known[root] ?? 游标`），树内用 `d3-hierarchy` 的 `nodeSize` tidy，再"锚点 + 偏移"展开，用户拖过的节点最后覆盖、连布局都不参与。**"加一个叶子不重排整图"因此是按树成立而非按节点成立。**

Phase 0 设想的 `childCursor`（每父节点递增 y 偏移、绝不回写）比这更强，但被真实模型推翻：模型会在任意深度插节点，不回写的游标必然重叠。全局 tidy（`elkjs` + Web Worker）从未落地也不该落地——其许可证是 EPL-2.0/GPL-3.0 可选（ADR §10），而 §43 只要求"不整体重排"。`dagre` 被否：0.8.5 于 2019-12 冻结，且 `layout()` 覆写所有坐标。

### 1.11 配置面与四档真实度

所有配置只由 `packages/backend/src/config/env.ts` 读取；变量清单见 `.env.example`。**已存在的环境变量优先于 `.env`**，所以临时切档用命令行前缀而不是改文件。四档（全 Mock / 真实 STT / 真实 LLM / 真实 embedding）的起法与代价在 `README.md`。

### 1.12 交付形态

构建后 **后端进程自己伺服前端 `dist`**（`STATIC_DIR`，目录里没有 `index.html` 就不挂载，所以源码开发照旧），安装包因此只需要一个常驻进程 + 可选 worker。四个包：必装 `RCC-Core-Setup.exe`（Mock 全功能）+ 三个可选模块 M1（ONNX 运行时）/ M2（bge-m3 权重）/ M3（sherpa 模型）。装完之后"哪些能力真的可用"不是台账而是**派生**出来的：`deriveModules()` 被 `RCC-modules.bat`、`/health.modules` 与启动日志共用（详见 ADR §6.5 D-36 与本文件 §4）。

---

## 2. 时间线：每个阶段加了什么、遇到什么问题

设计文档 §53 只排到 Phase 9（"真实长时间测试"），**没有 Phase 10**；本文里的 Phase 10 及之后是本仓库为"接真实 LLM"和"交付形态"自设的阶段，ADR 里凡引用规范字面处都会注明这一点。每个阶段末尾的「遗留」是**当时判到哪一步**的诚实边界，不是待办清单的替代品。

### Phase 0 — 开源生态侦察

**加了什么**：`OPEN_SOURCE_SURVEY.md`（334 行）、ADR 初版、`THIRD_PARTY.md` 台账骨架；本机环境一手测量（CPU-only、16 GB、Iris Xe 核显、无 Docker）；STT / VAD / Audio Capture / MindMap 渲染 / 图布局 / Embedding / 向量检索 / Memory / LLM SDK / Event Bus / 后端栈 的候选清单与替换成本；21 MB 小模型的 RTF 基准 0.034–0.037。

**遇到的问题**：
- **本机的网络可达性是一条架构约束，不是环境问题**：`npm ping` PONG 27 秒、PyPI 安装多次 15 s 读超时、`huggingface.co` 完全不可达（000），`hf-mirror.com` 与 `modelscope.cn` 可达；curl GitHub 系需要 `--ssl-no-revoke` 才不报 `CRYPT_E_REVOCATION_OFFLINE`；`api.github.com` 匿名限流 60 次/小时；511 MB 模型下载中途断连一次需断点续传。据此把模型改为"一次性手动下载 + 校验 + 本地缓存，不进关键路径"，并把依赖版本全部钉死（R5）。
- **二手结论不可信，这条是被反复兑现的**：sherpa-onnx 文档里的"自带 websocket server"、LLM 厂商 README 里的"支持结构化输出"、社区给的"数百节点会掉帧"，后来**每一条都被一次调用/一次基准推翻**。Rule 4 的登记格式（尤其"零二次开发 / 自带 / 支持"这类词必须落到一次可复现的动作上）就是为此而写。
- **Phase 0 自己的清单里就有两条从没落地**：§8 那节防泄漏纪律四条中 `onlyRenderVisibleElements` 与"默认折叠 depth>2–3"从未开启，2026-10-20 逐条核对代码时才暴露（那条清单还被据此改写成"别照它读代码"）。
- License 必须**代码与权重分别核对**：PyPI 元数据的 License 字段为空不能据此下结论（要读已安装包的 `dist-info/licenses`）；`jina-embeddings-v3` 因 CC-BY-NC-4.0 直接阻断商用；`gte-Qwen2-1.5B-instruct` 的权重是 tongyi 定制许可、非 OSI；`elkjs` 的 EPL-2.0/GPL-3.0 可选被记入风险登记表。

**遗留**：R1（中文准确率）从一开始就没被任何数字覆盖，至今仍未（见 §5）。

### Phase 1a/1b/1c — 骨架（Frontend / Backend / Shared Types / Event Bus / Canonical Schemas，不接真实 STT）

**加了什么**：npm workspaces 与 `tsconfig.base.json`；`packages/shared` 的 Canonical Schema、六种 Graph Operation、纯 reducer、事件与 wire 协议；后端 emittery 总线（带每订阅隔离）、`node:sqlite` repository 层、GraphStore/Mock STT/RecordingController/Fastify+WS API；前端 Vite + React + Zustand 的 60/40 布局、字幕面板、React Flow 视图；Adapter Contract / partial 不持久化 / 图操作含非法输入 / 四类故障的测试（§51）与一条完整 E2E（§52）。

**遇到的问题**：
- **TypeScript 的两个严格开关在这里改变了代码形状**：`noUncheckedIndexedAccess` 让所有下标访问必须显式处理 undefined，`verbatimModuleSyntax` 强制 `import type`——一开始觉得啰嗦，后来它们各自挡住过一条真缺陷。
- **跨会话主键会静默丢数据**：Phase 1c 抓到"同一行换个 session 就写不进去/读不出来"这类静默丢失，直接导致后面所有表都采用 `(session_id, …)` 复合主键。同一形状的问题在 Phase 7 又以另一种形式复发（丢掉一段嵌入 = 索引里永久的洞，见 D-8），所以这条被列为"最坏的一类静默缺陷"。
- **`npm install` 能不能在这台机器上真跑完，是一件需要排在第一位验证的事**（R5 的连带后果），不是理所当然的前提。
- **Vite 的 cwd 语义**：生产构建后必须**在 `packages/frontend` 目录里**跑 preview，从仓库根 `npx vite preview` 会报 `The directory "dist" does not exist`。这条到今天仍然会咬人，写在 README 里。

**遗留**：`questions` / `answers` 两张表按 §40 建了，但**整个 Phase 1–8 没有任何 INSERT**，直到 OPEN-4 在 2026-10-20 才补上写入路径（见 §3 的"死表"那一格）。

### Phase 2 — Mock Pipeline（Mock STT → Transcript Store → Subtitle UI）与 LLM wire 契约

**加了什么**：确定性 Mock 讲解脚本（`MOCK_SCRIPT`，79 s / 8 段）按排定时刻播 partial+final → 字幕；LLM Adapter 的**真实 wire 契约测试**（`test/llmStubServer.ts` 起本机 OpenAI 兼容 HTTP/SSE 端点，不需要 key）覆盖 markdown fence 与散文明细的恢复、repair prompt 内容、放弃、503 降级只伤导图；MindMap Agent 接到该 stub 的集成验证（含 repair 与失败降级）；orphan buffer 批内重试（2c）。

**遇到的问题**：
- **adapter 早期只校验 `z.array(z.unknown())`，导致 §45 的修复通道是死代码**：形状非法的 op 在 reducer 门口被静默丢弃，repair 循环**永远不会触发**。修法是两层用同一个 per-op schema（语义类拒绝才留在第二层）。这条被写成"有真实 wire 证据"的前提。
- **repair 与传输重试叠乘**会造成单次 flush 最多 9 个请求且全程持锁——于是 `MAX_REPAIR_ATTEMPTS=1` 写死在 adapter 里，不复用 `LLM_MAX_RETRIES`。
- **推理模型的 `enable_thinking` 必须先关**：开着思考的同类调用实测 27–106 s，直接打穿 30 s 超时预算。

**遗留**：真实 provider 的行为全是推测。这个欠账在 Phase 10 用一次真 key 接入还清，并当场抓到一条比风险描述更严重的缺陷（见 D-31 与 §3）。

### Phase 3 — MindMap（Transcript → MindMap Agent → Graph Operation → Graph Engine → React Flow）

**加了什么**：`layoutGraph` 的按树锚点 + `d3-hierarchy` tidy、`pinned`/`childOrder`/`collapsed` 三个布局切片、`graph_positions` 表（只存拖拽）、节点标题与 `sourceTranscriptIds` 的引用跳转、Debug Panel（§48）配合 `graph_operations` 审计日志。

**遇到的问题**：
- **`childCursor` 被真实模型推翻**（见 §1.10）。
- **大图性能没有可信数字**：R3 说"数百到上千节点可能掉帧"用的是社区估算。Phase 3 的出口条件本该是本机 500/1000 节点 FPS 压测，但本环境的无头浏览器**不出画**（无原生 viewport），于是这条被推到一个自设的前置任务上——先补确定性的 `?bench=N` 种子路径。真正跑成是 **2026-10-20**（Phase 9 期间，D-26），距 Phase 3 已经很久。
- **`minZoom=0.25` 使 N≥200 后 fitView 永远框不住整棵树**（截图证据 `.scratch/bench-1000-fit.png`），属产品取舍（§58(d)），登记而未改。

**遗留**：默认折叠与 `onlyRenderVisibleElements` 的实际收益至今无量（要新的测量工具，不是时间）。

### Phase 4 — QA（Question + Hot Context + MindMap → LLM）

**加了什么**：`ContextSnapshot` 冻结语义（新到的 transcript 不改本次上下文，§32）、Hot Context 窗口、流式回答分块回 UI、`[mm:ss]` 可点引用、Mock LLM 的确定性假答案（§50 的无 key 环境要求）。

**遇到的问题**：
- **这一档需要用户自提供 API Key，是 §58 列出的四种必须停下问人的情形之一**。当时的处理是：把问题问清楚（要 key 与端点），同时**不阻塞**——先用本机 stub 端点把 wire 契约全部测穿，保证真 key 一到只需要改三行配置。这是本项目唯一一次真正行使 §58 的停车门。
- **引用格式比想象的不听话**：模型会把时间写成分组括号，`citations` 解析因此要按实测形态放宽而不是按理想格式写死（Phase 10 的三处修复之一）。
- **热上下文与索引候选会重复引用同一句**：修法是把热窗口的 id 作为排除集传给索引，并按 `[mm:ss]` 逐条断言。

**遗留**：`questions`/`answers` 仍是死表（OPEN-4）；QA 的限流与准入要到 Phase 8b 才存在；"十分钟前的定义"这个尺度要到长跑才构造得出来。

### Phase 5 — 接入真实 STT（Microphone → Audio Pipeline → STT Adapter → Transcript Event）

**加了什么**：`services/stt-worker/stt_worker.py`（356 行薄进程：sherpa-onnx OnlineRecognizer + websockets，自定义协议 v1，二进制 PCM 入 / JSON 结果出，零业务逻辑）；Node 侧 `SherpaSTTProvider` + wire 契约测试；前端 AudioWorklet 16 kHz 采集与降采样；重连与预算；`requirements.txt` 钉版本；双语 zipformer 模型接入。

**遇到的问题**（这一阶段产出的"实测推翻文档"最多）：
- **"用 sherpa-onnx 自带的 websocket server"是错的**：1.13.8 的那个示例本身要自己写服务端，worker 是我们写的。这条先作为文档纠错登记，再进代码。
- **端点判定与标点**：流式 transducer 实测**不出标点**（OPEN-1 就此关闭，策略是"原文保持原样、可读性交给摘要/导图的 LLM 侧"，而不是再加一个标点模型吃一跳延迟）。判停用 rule2 的 0.8 s 窗口。
- **`final` 延迟曾被读成"稳态"**：D-20 记的"final 迟到 p50 0.95–1.81 s"其实是**收尾样本**；37 分钟长跑复测后稳态只有约 30–95 ms 的处理 + 0.8 s 判停窗口。数字没错，归因错了。
- **重连预算的真实余量被长跑改写**：`D-21` 据以定预算的 19 s 恢复时间是**冷启动**测的，warm 停机实测只有 3.9–4.6 s——所以预算对冷启动只剩约 5 s，不是当初以为的 5 倍余量。
- **重连把两条钟解耦了**，而 `[mm:ss]` 引用挂在**转写钟**上：12 分钟里杀 5 次 worker，转写钟落后墙钟 30.4 s（4.2%）且按停机线性累积，UI 不说这件事（OPEN-6 ⑥）。
- **断线期间的音频是丢弃，不是排队**（否则恢复即洪峰），代价如实写进 ADR。
- **参数漂移会被误读成"不可复现"**：同一份音频在 greedy / beam 下的分段与叠字不同，一度被当成回归。此后起 worker 的参数钉死在 `.scratch/stt-worker-launch.mjs`，禁止在脚本间手抄。
- **Mock 的诚实性**：`MOCK_STT=true` 时按麦克风必须得到 `module.error{code:"mock_mode_active"}`，不允许悄悄播一遍脚本冒充真实路径。

**遗留**：中文准确率（R1）；浏览器 AudioWorklet 数小时采集（两次长跑喂的都是 wav 循环，不是麦克风）；冷启动下的重连；`mindmap_edges` 的真实语料覆盖（两次跑各 107/335 节点，一条 `add_edge` 都没产生）。

### Phase 6 — Memory（Summary Blocks）

**加了什么**：`SummaryBlock` 类型与 `summary_blocks` 落库；`MemoryCore` 按**语音时间**累计 3–5 分钟触发阶段摘要；分层 merge（level 0 阶段摘要，>0 合并块）；接进 runtime、QA 上下文、WS 桥与 Mock LLM；本阶段**零新依赖**（D-5）。

**遇到的问题**：
- **§31 字面要求的是墙钟节奏，实现改成量"语音时间"**：暂停时不该继续累计，否则一场讲 5 分钟的会话会因为中间停了 20 分钟而被切出一堆空块（D-1）。这是一次"按字面实现会做错"的取舍，写进 ADR。
- **一个 `parentBlockId` 装不下 n 元合并**：树形血缘只能表达二元，合并块的真实语义是"一组子块"。做法是保留原字段作为**第一个子块的锚点**（不破坏已有数据），加法式新增 `sourceBlockIds[]`（D-2）。
- **阶段摘要失败 = 前进，合并失败 = 原地重试**（D-3）：前者损失的是"概览少一块"，后者重试会反复吃掉同一批子块。
- **合并深度与喂给 QA 的概览长度必须有上界**（D-4），否则长跑后 prompt 无界增长。
- **后加的列不会自己出现**：`CREATE TABLE IF NOT EXISTS` 对已有行不加列，`source_block_ids` 靠 `ensureColumn()` 补齐；没有这一步，Phase 6 之前的库文件会在第一次 merge 落库时抛 `no such column`。

### Phase 7 — Retrieval（Embedding + Vector Search，7a–7e）

**加了什么**：`embeddings` 表 + float32 小端 BLOB 编解码 + Top-K 排序（7a）；`EmbeddingProvider` Adapter + Mock 向量（7b）；`RetrievalCore` + QA 接线（7c）；真实 ONNX embedding（`@huggingface/transformers` + `Xenova/bge-m3` q8，1024 维）落到独立 `worker_threads` + 延迟实测 + THIRD_PARTY 登记（7d）；Test D 的 e2e 与 Rule 8 实跑（7e）。整个 7a–7c **零新 npm 依赖**。

**遇到的问题**：
- **Phase 0 的"毫秒级"是估算，实测慢一个数量级**：3000×1024 暴力扫约 68 ms 且**同步阻塞**。没有据此推翻"不引入 ANN"，而是把"证明不够"写成可复核的阈值：行数 >3000 或 p50 >100 ms 才复评（D-6）。
- **Mock 向量是词法下界，不能用来反证质量**：它做不到把"世界模型"与 "world model"/"内部预测"判成同义。所以 mock 下任何 top-K 指标都只是下界（D-7）。
- **摄取不能用 MindMap 那种"忙则跳过"**：跳过一批导图会被下一批窗口补回来，**丢掉一段嵌入是索引里永久的洞**，而原文还在库里——用户永远问不到那一句，系统表面一切正常。改成有上限的队列（512）+ 溢出只报一次事件，批失败丢弃不重试（D-8）。
- **两种向量空间绝不混排**：`scan` 把 `provider` 与 `dim` 都写进 SQL。不同模型产出的 cosine 是"自信的错误答案"，混排后没有任何下游信号能发现（D-9）。
- **检索失败绝不能影响"还能不能问"**：`search()` 内部 catch 到底返回 `[]`，`QaCore` 外面再包一层——唯一理由是 `inFlight` 的加减必须平衡，否则索引一坏两次未完成请求就把 QA 永久锁死成 busy（有单测专门锁这条，D-10）。
- **"假装可用"曾被登记为唯一未完成项**：7d 之前真实 embedding 是一条都没有的，ADR 拒绝继续把它写成"支持中"。
- **主循环侵占实测 1881 ms** → 推理挪出主 loop。选 `worker_threads` 而不是拆进程，依据是对照实验：线程内跑完推理后，字幕投递延迟相对各自排定时间戳只从 2 ms 推到 p95 +3 ms / 最大 +4 ms，而线程内直跑时主 loop p99 是 404 ms。**Rule 6 未被突破**（同一 OS 进程内的独立线程不是独立服务），代价（原生崩溃连坐）如实记着（D-12）。
- **模型选型付的代价要写清**：bge-m3 跨语种实测相关对 0.9129，亚军 `bge-base-zh-v1.5` 只有 0.6779；但体积 5.7 倍（560 MB vs 99 MB）、首 token 更慢、**绝对分数整体偏高**（无关句也能到 0.6）——所以阈值必须重校（D-13，见 §1.8）。
- **npm 的 install script 被审批策略拦下，但不需要放行**：`onnxruntime-node@1.30.0`、`protobufjs@7.6.6`、`esbuild@0.28.2` 三个脚本被拦后，导入与推理仍完整可用（D-14）。这是"先测再决定要不要放宽安全策略"的正面样本。

### Phase 8 — 稳定性（Reconnect / Retry / Rate Limit / Single Flight / Error Isolation / Logging，8a–8d）

**加了什么**：`loopDelay` 常驻记录（§47 要求的事件循环延迟 + `/api/debug` 队列观测）；QA 入口两道闸（并发上限 + 最小间隔）与 `answer.rejected{reason:"busy"|"rate_limited", retryAfterMs}`；前端 WS 重连 + 状态 resync；Test E 的**故障注入验收**（真 provider 抛错、监听器抛错、adapter 指向空端口）。

**遇到的问题**：
- **仪器本身要先校准**：空闲进程的 loop delay 读数受 Windows 定时器粒度影响，不写清下限，Phase 9 会把噪声当结论（D-15）。
- **"拒绝"不是故障**：限流拒绝必须走 `answer.rejected` 而不是 `module.error`，否则用户看到的全局错误通道会被正常使用填满。
- **只持久化拖拽，不持久化布局**（D-17）：把自动布局坐标也存进去，等于把一次布局改动变成一次数据迁移。
- **回答不重放，因此重连后必须就地关闭**：断线期间在途的那题气泡不能永远停在"等待回答…"。
- **失败路径不能把刚释放的批次再吃进去**（实跑发现并修掉的真缺陷）：见 §1.6 隔离条 7。
- **两个 bug 在开跑之前就被针对性单测抓住**——这条被写下来是为了对抗"单测没用"的误读：它们抓不住后面那些环境级问题，但抓住了自己的。

### Phase 9 — 真实长时间测试（Test F：至少 30 分钟，最好 60–120）

**加了什么**：soak 采样面与逐条判定（泄漏斜率 / 事件计数 / 节点重复 / AI 请求堆积 / 字幕间隙 / `module.error`）；**为大图基准补上确定性种子路径** `packages/frontend/src/dev/benchSeed.ts`（`?bench=N`，6 根、深度 ≤4、夹到 2000，5 条单测锁不变量，且**有意被打进生产包**）；**取得一台真出画的浏览器**——用操作系统已装的 Edge 无头实例 + 自写约 120 行 CDP 客户端跑在已登记的 `ws` 上（**Rule 4 账目为零：没新增任何第三方包**）。

**遇到的问题**：
- **31 分钟实跑的诚实结论**：loop delay p95 全程 16.5→16.7 ms 平直，监听器数钉在 35，heap 斜率与有意留存数据的量级相符，`module.error` 0 条，stop 后事件计数零增长。但 **Test F 五条里"UI 明显卡顿"这一格本场给不出证据**（无浏览器长跑），而且这场全程 `MOCK_EMBEDDING=true`，所以"原生模块崩溃连坐"那半条风险**不因这场长跑而销账**（D-19）。
- **500/1000 节点基准跑成之后，第一个结论是"担忧被证否"**：1163 节点下缩放/平移/空转 455 帧，p50/p95/p99 全 17 ms，>50 ms 的帧 0 次——**"迁移 Canvas 渲染层"这条降级阶梯因此失去实测依据**。
- **但同一批数据在另一个维度亮了红灯**：每批 `applyOps` 的同步部分只有 4–13 ms，而 `applyOps → 下一次绘制` 是 18–362 ms，生产批次形状下**加一个节点要 14/106/327 ms 才上屏**。
- **我第一时间把这口锅判给了 `buildFlow` 每批新建对象，随后写缓存、复测、撤回**：节点引用缓存跨树批次 0% 复用、单树 62%、钉住的分支 94%，而 paint **一格都没改善**。CPU profile 折算每批是"浏览器非 JS 工作 ≈231 ms + React 协调 ≈55 ms + React Flow 内部 ≈43 ms + GC ≈30 ms + DOM API ≈18 ms + 我们自己 ≈10 ms"；关掉全部边只降三分之一，开 `onlyRenderVisibleElements` 把 DOM 从 1163 压到 29 个节点反而稳定在 229 ms。**所以诚实状态是：延迟真实存在、原因未知、且不在我们代码里**（D-26 同日更正，挂 OPEN-5）。
- **heap 那一格不许当结论用**：采样面与 GC 时机不足，被就地标注。
- **三条测量卫生的坑，每一条都曾产出一个假数字**：无头浏览器不出画（量到的"帧"是空转）、探针进程与被测进程混用同一份环境、`dpr` 与窗口尺寸不可比。加上第四条：**浏览器版本必须打进每跑首行日志**（D-20 的教训沿用）。

### 部件稳定性加固 — 三轮全仓库审计（D-27…D-30，任务 #41–#56）

**加了什么**：不是新功能，是**把静默失败改成可见失败**。第一轮 11 项、第二轮 6 项、第三轮 3 + 4 项。

**遇到的问题（选几条最能说明"审计为什么值得单列一轮"的）**：
- **P0 级四类"会静默丢数据"**：迟到的 LLM 响应写进已经结束的会话（缺 closed 闸门）；`GraphStore` 先改内存后写库，写库失败造成内存与磁盘静默分叉；`saveEdges` 无事务，中途失败清空所有交叉边；embedding worker 无代际校验 + 监听器泄漏 + 退出静默。四项各配故障注入测试。
- **一项审计描述本身被证否**（"11 项都处置过了"不等于关掉）；**两项 P2 测完之后判定不该修**（改了会更糟）。
- **"单飞链被空 Promise 顶掉"这同一个缺陷在三个不同部件里第二次、第三次出现**（导图 `flush()` 在途时是 no-op 尾批静默丢图；摘要 `running` 被空 Promise 顶掉；`runMerges` 先释放子块后落库）。这个复发模式比任何单条缺陷都更值得记。
- **`merge_node` 缺祖先校验，成环后整枝静默不可达**（共享层 P1）。
- **转写落库失败会击穿整个进程**（后端 P0）——正好是 §1.6 隔离纪律要防的那种。
- **前端：采集失败即泄漏麦克风；断线时"结束/暂停"按钮反而被禁用**（用户最需要在断线时停下的时刻停不下来）。
- **字幕无条件吸底把往上翻的读者每来一行就拽回底部**：这条**只有真浏览器能量**，而测量台为此**自己错了两轮**才量对。最终红绿对照用的是同一脚本、同一构建路径。
- **"快照会静默丢掉一整枝"的真正教训在控制组里**：探针写出来先要保证靶子真的存在，否则一条永远为真的断言什么都锁不住（同批次还有一条"测试写了却锁不住任何东西"）。
- **partial 与 `askedAt` 无上限累积**：长跑里的第二类泄漏风险（不是内存斜率，是无界结构）。
- **实跑顺手抓到一条比这一轮四项都大的事**：重启后旧会话的导图读不回画面——`hydrate()` 有实现有单测，但生产里 `start()` 每次都用新 `randomUUID()`，所以节点在盘上却回不到屏幕上。这条登记为 **OPEN-7**，并且把 `hydrate()` 原文那句"Rebuild from disk so a restart does not lose the tree"（**被实跑证伪**）改成了带实测边界的说明。

### Phase 10 — 真实 LLM provider 接入（D-31）

**加了什么**：`OpenAICompatProvider` 第一次接真实 key 与专属端点跑通端到端；三处修复（`parentId: null` 放宽并配控制组、推理模型 `content` 饿死的处置、分组括号引用的解析）；四模型普查（`.scratch/llm-null-census.mts`）。

**遇到的问题**：
- **第一条实测就把 §7 的选型依据推翻了**：真实模型给每个根节点写 `"parentId": null`，而闸门当时把 `null` 判成非法字符串——**整批拒绝，每一批都拒**，真 provider 一个节点都长不出来。四模型普查确认这是共性不是个案。
- **为什么单测抓不住（这是一条项目级陷阱，比上面那条更值得记）**：后端运行时 import 的是 `packages/shared/dist`，而单测直接 import `src`。**改了 shared/src 忘记 `npm run build -w @rcc/shared`，形状就是"全仓测试全绿、真实端到端照旧失败"。** 这条已写进 README 的"会让人白跑的坑"第一位。
- **`json_schema` strict 在该端点不可用**（直接回 `This response_format type is unavailable now`）：所以"厂商 strict"这层保证今天根本拿不到，四道闸是唯一存在的保证。选型时把 README 的"结构化输出"读成了"strict 可用"，与 D-20 那条同源。
- **各家参数并不通用**：`enable_thinking` 只有 qwen / deepseek / kimi 接受 `false`，`glm-5.3` 拒绝它；反过来 `kimi-k3` 拒绝一直在发的 `temperature=0.2`。**"逐厂"这个说法要打折**：量到的几家都托管在同一个 DashScope 专属实例上，各家官方端点仍未验证。
- **用户纠正了测量方式，这条记成纪律**：最初打算用较贵的小模型逐个试，被指出「别用 qwen3.8flash 呀，用 dsR1 这种小模型看能不能用就行了，你这是不必要的开销」→ 固化为：**花钱的验证先用最便宜样本确认"能不能用"，选型矩阵只在真要区分厂商时才付，一次请求就够。**

### 定稿轮 — 把承诺收口（D-32…D-35）

- **D-32（Test F 的 60–120 分钟区间 + Test A 的页面级首证）**：60.05 分钟跑满（§53 的"最好"区间下限达成，注意规范字面底线只有 30 分钟）；五里四有数，"UI 明显卡顿"两场都仍无证据。Test A 的目标句距排定时刻 **26 ms**、UI 自身开销 11 ms，截图肉眼核对。**这一跑差点被一个陈旧后端骗过去**（端口上还挂着一场"上一轮"的进程），因此新增环境纪律：探针启动前必须验活的是**自己刚起的那个 pid**。
- **D-33（节点摘要落地，以及一次被尺子骗出来的 CSS 撤销）**：按用户决定改 `prompts/mindmap.ts` 要求逐节点写摘要 + Mock 生产者 + 闸门放宽（空摘要不得毁整批，判别测试实测**先红后绿**），一发真实请求证到模型真会写。**第一版探针报的"文字贴边"是尺子错算**——把 React Flow 视口 `scale` 与布局像素混用了；修正后最坏情况元信息距裁切边 6.5 px，**一次据此做出的 CSS 改动已撤销**。
- **D-34（单会话结构化导出 / 导入 = 可提问的历史会话）**：`GET /api/session/:id/export`、`POST /api/session/import`、`GET /api/session/:id/questions`（OPEN-4 的读取侧随之关闭）；`schemaVersion: 1` 的 JSON 里**不放向量**（导入时重新嵌入，文件保持人可读）；身份改写规则被实测**收窄成只有 `questions.id` 一列**（其余四张表都是 `(session_id,…)` 复合键，重打即自洽）；`viewing` 做成 `session.snapshot.state` 的**第四个值**而不是旁挂布尔标志；OPEN-7 那一问用两个进程钉死（`.scratch/live-restart-import.mjs`，7/7：真 kill 再换一个进程指向同一个库）。**一条测量台边界**：本机的无头 Edge 会 `canceled` 它接受的每一个下载（包括同源 HTTP 直链），所以"文件真的落到磁盘"这一步在探针里**不可观测**——正常浏览器里的下载从未验证过。
- **D-35（后端自己伺服页面）**：一条安装包绕不开的前提。闸门只认**原始 request target**，而这是实测出来的选择；`app.inject()` **不能作为路径穿越的证据**（它会先把 URL 规范化，把穿越"修好"），所以必须打真实 HTTP 端口；**对照组必须先证明靶子存在**；缓存与类型是两条会真实咬人的规则（hash 资产 immutable + `nosniff` + 不发目录列表）；浏览器级探针抓到一条真红。非 loopback 现在会被日志提醒。
- **定稿前的一次全量引用对账**抓出三处失效锚点，**其中一处就在代码里**（注释引用了一个不存在的章节）。这类账必须一次性对完，否则 ADR 的价值逐月衰减。

### 交付轮 — 安装包与可选模块（D-36）

**加了什么**：四个包（必装核心 + M1 运行时 + M2 embedding 权重 + M3 sherpa 模型）；`tools/package.mjs`（staging，把运行时从**已安装的 `node_modules` 走 import 图遍历出来**，保留 npm 的嵌套副本）；`tools/make-installer.mjs` + 内嵌 `tools/installer/Setup.cs`；`RCC.bat` / `RCC-stop.bat` / `RCC-modules.bat` 三个双击面；`/health.modules` 与 `deriveModules()`。

**遇到的问题**：
- **IExpress 是被"矩阵证否"的，不是被一次失败否决的**：它启动 `makecab.exe`，`makecab` 手跑成功，但中间 cabinet 从不生成，每次构建都停在 `Unable to open the Cabinet file`，磁盘上只留下 172 032 字节的壳。八种 SED 形状 × `/N`、`/N /Q`、`/N /A /Q`、裸跑 × `InsideCompressed` 0/1 × `InstallApp`/`RestoreFiles` × 中文/ASCII cwd × TEMP 改 ASCII，**结果全部相同**之后才改道。新路线是这台机器上本来就有的编译器：`Microsoft.NET\Framework64\v4.0.30319\csc.exe`，把 `payload.zip` 作为资源嵌进 exe。代价是 pre-Roslyn 只到 C# 5；两个白捡的好处是**不再要求 ASCII 安装路径**（中文走 UTF-8 manifest 资源）和**装机不需要 bsdtar 或向导**（.NET 自己读 zip）。
- **一条只有 Windows 会犯的错，它变成了闸门**：一次探针传了 `--build=D:\rcc-build` 与 `--staged=D:\rcc-build\mini`，`work` 变成 `D:\rcc-build\MINI`——**与 `staged` 是同一个目录**（Windows 路径大小写不敏感）。`tar` 于是把正在写的 `payload.zip` 打进包里，产出一个 0 字节条目、**退出码 0**、只有装完检查才发现。现在 `assertDisjoint()` 在任何删除动作之前拒掉这种重叠。
- **台账被自己的产品决定否掉**：原设计要写 `installed-modules.json` 记录装了什么。真做的时候发现**台账会说谎**（手动往目录里拷模型不算安装），于是删掉台账改为 `deriveModules()` **从文件系统与配置反推**，让菜单、`/health`、启动日志共用同一个推导函数——"会说谎的菜单比没有菜单更糟"。
- **回落的方向盘在用户手里，不在我手里**：装了 M1+M2 但 `MOCK_EMBEDDING=true` 时，菜单不静默启用真实推理，而是打一条错误记录（缺什么 / 怎么补 / 补了会怎样）并提醒那句配置。**静默替代仍然禁止。**
- **打包探针抓到两条产品级缺陷，两条都不是检视能发现的**：
  1. 日志里 `{ message }` 字段会**覆盖掉"这条记录是什么"的标签**，波及 11 个调用点；修法是保留名字典 `{message:"detail", level:"detailLevel", ts:"detailTs"}`。第一版把三个字段都塞进同一个 `detail`，**被我自己写的测试逮住**（`Expected: "yesterday" Received: "nonsense"`）。
  2. `metric:retrieval_search` 里的 `candidates` 是在 Hot Context 排除**之后**计数的，所以在短于一场会话的回答里 `candidates: 0` 无法区分"索引从没填进去"与"每一行都还在热窗口里"——只有后者是正常的。新增 `scanned`（排除前的计数）并用单测锁住这条判别（`RetrievalCore.ts` + `retrievalCore.test.ts`）。**这条如果不改，安装态验收会得出一个假结论。**
- **M3 的 staging 此前是错的**：整目录 1.1 GB 里有 fp32 与 int8 两套权重和不需要的演示文件。改成 16 文件 / 530.7 MiB，**拒绝来源不合格的安装包**，保留目录名（这样 `RCC-modules.bat` 打印的 worker 命令是真能跑的），并把 `requirements.txt` 一起放进包。
- **两次真装真跑全绿**：缺模块档 **19/19**（剥离后的核心，`MOCK_EMBEDDING=false` 时 provider 仍是 `onnx:Xenova/bge-m3:q8`、启动有一条 `missing:["m1","m2"]` 的错误记录、且没有任何 `using mock embeddings`）；加装档 **13/13**（M1 覆盖安装 5.1 s、M2 目录拷贝 0.9 s、菜单翻成"已装"、`embedding model ready dim=1024 loadMs=3368`、库里读到的是真实向量、答案带 2 条引用、按记录的 PID 收尾）；装出来的应用自身的 launcher 链 **8/8**（含"页面由装出来的应用伺服"，`/health.modules` = m1 true / m2 true / m3 false）。

---

## 3. 把决定推翻过的实测（一张表）

这张表存在的理由是：**这些结论如果只写在"经验教训"里就会被忘掉，写在时间线里就会被当成进步**。每一行都是"当时的信念 → 量到什么 → 现在怎么写"。

| 当时的信念 | 实测 | 结论改成什么 |
|---|---|---|
| sherpa-onnx 自带 websocket server（Phase 0 文档） | 1.13.8 的示例要自己写服务端 | worker 是我们写的 356 行薄进程（D-20） |
| 流式 STT 的 `final` 迟到 0.95–1.81 s | 37 分钟 1× 定速长跑 | 那是**收尾样本**；稳态 ≈ 0.8 s 判停 + 30–95 ms 处理（D-24） |
| 重连恢复要 19 s，预算有 5 倍余量 | warm 停机实测 3.9–4.6 s | 19 s 是**冷启动**，对冷启动只剩约 5 s（D-25） |
| 1163 节点会掉帧（社区估算） | 455 帧 p50=p95=p99=17 ms，>50 ms 帧 0 次 | "掉帧"证否，**Canvas 迁移阶梯撤销**；真问题是新节点 14–327 ms 才上屏（D-26） |
| 那 200 ms 是 `buildFlow` 每批新建对象 | 加缓存后 paint 一格没动（单树复用率 62%） | **否定结果，缓存已 revert**；profile 里大头是浏览器非 JS 工作（≈231 ms/批），归因至今未定（D-26 同日更正） |
| 摘要节奏按墙钟（§31 字面） | 暂停会切出一堆空块 | 改量**语音时间**（D-1） |
| 一个 `parentBlockId` 能表达合并血缘 | n 元合并装不下 | 保留原字段为锚点 + 加法式新增 `sourceBlockIds[]`（D-2） |
| 向量扫库"毫秒级"（Phase 0 估算） | 3000×1024 约 68 ms 且同步 | 不引入 ANN，但写下复评阈值：行数 >3000 或 p50 >100 ms（D-6） |
| embedding 必须走 `child_process`（因为原生崩溃会连坐） | 线程内直跑时主 loop p99 404 ms；`worker_threads` 后字幕 p95 +3 ms | 改 `worker_threads`，不拆服务；连坐残余风险照记（D-12） |
| DashScope 支持 strict `json_schema` | 端点直接回 `This response_format type is unavailable now` | 只有 `json_object` + 我们自己的 Zod，**闸门没有第三层**（D-31） |
| 真实模型会按 schema 写 `parentId` | 四个模型都给根节点写 `parentId: null`，整批被拒 | 字段放宽 + 控制组；`null` 与缺失同义（D-31） |
| 节点摘要"文字贴边"需要改 CSS | 探针把视口 `scale` 与布局像素混算了 | 修正尺子后最坏 6.5 px，**CSS 改动撤销**，`NODE_H` 不改（D-33） |
| `app.inject()` 里的路径穿越被拦 = 闸门有效 | `inject()` 会先规范化 URL，把穿越"修好" | 闸门只认原始 request target，必须打真实 HTTP 端口验证（D-35） |
| IExpress 的失败是 `.sed` 写错了 | 八种 SED × 各参数组合 × 中文/ASCII cwd × ASCII TEMP 全同 | `.sed` 不是问题；改道 `csc.exe`（D-36） |
| 装了模块 = 模块在用（台账记账即可） | 手动拷目录不进台账；`MOCK_EMBEDDING=true` 时台账更错 | **删台账，改派生**；缺模块只打错误记录与补救，不静默回落（D-36） |
| 打包产物会保留 `.map` 与 `.d.ts` | `find .scratch/pkg/core -name "*.map"` = 0；`isPayload()` 明确剔除 | 这是有意的瘦身，代价是**装出来的应用没有可读栈帧**，如实登记（D-36） |
| `candidates: 0` 说明索引空的 | 它是 Hot Context 排除**之后**的计数 | 新增 `scanned`（排除前）+ 单测锁住"空索引 vs 全在热窗口"的判别（D-36） |

---

## 4. 验证方法学（这个项目实际怎么"确认一件事"）

**Rule 8 的闸是五件套，不是四件套**：

```bash
npm run typecheck && npm run lint && npm run build && npm test   # 再加一次真实运行
```

`lint` 是 `biome lint .`，**不是** `biome check .`（后者会把格式化诊断混进来，闸就失去意义）。闸绿了还不算完：第五项"真实运行"必须在**声称的那一档真实度**上做——这就是 `MOCK_*` 静默替代被禁止的原因。截至 2026-10-22，闸的读数是 typecheck 干净、lint 114 个文件零诊断、build 通过、**281 个测试 / 37 个测试文件**全绿。

**四条长期有效的方法学**：

1. **测量面必须和判据同维。** Test A 要 DOM、Test F 的卡顿那一半要帧率，都不许用线级或计数顶替——这是 §14 那张对照表存在的全部理由。一格只有一个测量面。
2. **对照组先证靶子存在。** 一条永远为真的断言什么都锁不住；本项目有过"测试写了却锁不住任何东西"与"控制组才是本项真正教训"两次记录。
3. **环境级陷阱要写成纪律而不是重跑。** 探针必须验活"自己刚起的 pid"（陈旧后端骗过一次）；无头浏览器不出画时任何"帧"都是空转；`dpr` 与窗口尺寸不可比；浏览器版本打进每跑首行日志；杀进程只按 PID（`taskkill /PID <pid> /F` 或 CDP `Browser.close`），**按镜像名杀会连带关掉用户自己开着的浏览器窗口，这事在本项目真发生过**。
4. **否定结果必须写进文档。** 上面那张表里有一半是"做了、量了、撤了"。ADR 的规矩是正文不回改（它记录"当时判到哪一步"），更正另立一条并注明日期。

**`.scratch/` 是测量台**，包含真实 LLM 与真实 STT 的 live 探针、静态伺服与安装态验收、长跑与 CDP 脚本；`tools/` 是**交付物的一部分**，所以 Rule 8 的闸要覆盖它（改 `tools/` 或 `services/` 也要真跑一次装包）。**这个目录已进 `.gitignore`（里面有测试数据库和浏览器 profile），克隆下来是空的**——按 ADR 复跑任何数字之前，先确认脚本还在本机。

---

## 5. §56 验收：判到了哪一步，以及不许读成已覆盖

| 判据（逐字） | 判到 | 未覆盖的那一半 |
|---|---|---|
| Test A 字幕 2 秒内出现 | 真出画页面：目标句距排定时刻 26 ms，UI 开销 11 ms，有截图核对 | 参照钟是 Mock 的**排定时刻**，不是声波到麦克风的时刻；真实语音下的"2 秒内"从未做过页面级测试 |
| Test B 约 30 秒出现两节点、不频繁重排 | "不频繁重排"有断言且实跑一致（锚点单调、拖走的节点重载后停在原处、子树整体平移 236 px、未触碰的树仍 `x=0`） | 文档的例子树是**英文标题**；"约 30 秒内出现这两个具名节点"只在 Mock 语料上间接满足 |
| Test C 录音中提问，四件事同时 | 四条都有断言（答案可解码 + final 一条不少 + 导图同场长过 + 录音状态正常） | mock 以 500× 速度在 ~158 ms 放完 79 s 脚本，"继续"只能读成"完整"而非"与答案重叠"；真重叠证据来自 D-25（12 分钟真实 STT、7 题全落库、1 题落在 worker 停摆窗口） |
| Test D 可从历史 Transcript 检索 | 有一条离开 Hot Context 的旧行经索引被引回并成可点引用；阈值按实测分布校准 | "十分钟"是相对真实时钟的语义，测试用的是脚本偏移；中文"这个概念"的**指代消解没有任何测试** |
| Test E 双向故障隔离 | 两个方向都有断言（QA 全坏时导图照常长；模型全坏时字幕一条不少且请求不热循环） | 关的是 provider 层，不是进程级 kill；进程级那一半由 D-34 的 `live-restart-import.mjs`（真 kill 换进程指同一库，7/7）回答 |
| Test F 至少 30 分钟，五条不许有 | 31 分钟（D-19）+ **60.05 分钟（D-32）**；五里四有数：泄漏斜率 0.08 MB/min 且与留存数据成量、`365 = 365 = 365 = 365`、`dropped 0`、`dupAddNodeIds []`、请求 2.38 次/分恰为上界、`moduleErrors 0` | **"UI 明显卡顿"这半句两场都没有证据**；帧率数字属另一场 1163 节点基准，不能顶进这一格。60 分钟是**自设加强目标达成**，规范字面只有"至少 30 分钟"；真实 STT 的等长长跑最长仍只有 37.1 分钟 |

**交付边界（不许读成已覆盖）**：

- **中文准确率（R1）从未量化**。两次 STT 长跑用的是官方演示音频（28.7 s 中英混排语法课循环 74 遍），既不是真实演讲也不是中文为主的场合，对 WER 没有意义。**没有可信的 WER 数字**。
- **浏览器 AudioWorklet 数小时采集未测**（喂的都是 wav 循环）；**真人对着麦克风说话**这件事在本项目里一次都没有发生过，这是自设决定「只跑不需要人参与的复跑，然后定稿」的直接后果。
- **安装态的两次验收驱动的是 API/WS，不是页面里的 JS**。`packages/frontend/src/config.ts:2` 把 8787 写死进构建，改 `PORT` 后"页面连不上后端"这一格至今未覆盖（**OPEN-11**，默认端口形态是覆盖过的）。
- **交付前置条件有两格未清**：① exe 未签名（SmartScreen 首跑会警告，这是签名问题不是打包问题，登记为 OPEN）；② **本机 Node 安装目录里没有 `LICENSE`/`LICENSE.txt`（实测）**，所以安装包的 `runtime\node.exe` 是**没带许可文本再分发**的 MIT 二进制——**把安装包交给任何人之前必须先把许可证文本 vendor 进去**。
- **Setup.exe 不写注册表、不建快捷方式**（代码里 grep `Registry`/`.lnk` 零命中），所以"卸载 = 删目录"，没有卸载器；目标机需要 .NET Framework 4.5+，这一点**未在其他机器上验证过**。
- **`provider=mock` 出现在 LLM 相关 metric 上是预期**（`MOCK_LLM=true` 那档），不是缺陷；判断真实度要看 `MOCK_*` 与 `embedding/retrieval` 系 metric 的 provider。
- 那把 DashScope key 只在仓库根 `.env`，从未进入 `docs/`、ADR 或 THIRD_PARTY（2026-10-22 又用 key 原文对暂存树与 shipped 文档全扫过一遍：扫 6323 个文件，命中 0）。按用户决定**不轮换，开发结束后在控制台停用**——**停用之前这把 key 一直是有效的**，所以这份代码在此之前不应交到别人手上、也不应挪到局域网或公网（它与"无鉴权、只听 loopback"是同一条约束的两端）。

---

## 6. 复跑指引（想核实某个数字时从哪里进）

| 想复现 | 入口 | 属于哪一档 |
|---|---|---|
| Rule 8 四件套 | `npm run typecheck && npm run lint && npm run build && npm test` | 全 Mock，无需 key / 无需模型文件 |
| 全链路真实运行 | `.scratch/live-real-llm.mjs` / `live-real-stt.mjs` | 各自要 `MOCK_*=false` 与对应的 key / 模型目录 |
| Test A 页面级 26 ms | `.scratch/test-a-subtitle.mjs` + `test-a-result.json` | Mock STT + 无头 Edge（真出画） |
| Test F 60 分钟 | `.scratch/launch-soak.mjs` → `soak60-analysis.txt` | 全 Mock，需要 60 分钟无人参与 |
| 500/1000 节点基准 | 页面 `?bench=1000` + `.scratch/bench-*.mjs`（CDP） | 无头 Edge，dpr 1 / 1440×900 |
| 检索延迟与阈值校准 | `.scratch/live-onnx-retrieval.mjs` / `calib-scores.mjs` | 真实 embedding（M1 + M2） |
| 缺模块回落 | `.scratch/live-modules-stripped.mjs`（19/19） | 只装核心 |
| 加装 M1/M2 后翻"已装" | `.scratch/live-modules-added.mjs`（13/13） | 装完模块重启一次 |
| 装出来的应用本身 | `.scratch/live-launcher.mjs`（8/8） | 交付形态默认端口 |
| 打包 | `npm run build` → `node tools/package.mjs --tier=core,m1,m2,m3 --out=.scratch/pkg` → `node tools/make-installer.mjs --staged=.scratch/pkg/core --name=RCC-Core` | 见 `README.md` 的「打包与安装」 |

**两个会让人白跑的坑，最后说一遍**：改了 `packages/shared/src` 必须 `npm run build -w @rcc/shared`（否则全仓测试全绿、真实端到端照旧失败）；`--build` 与 `--staged` 不能在同一棵目录树下（Windows 大小写不敏感，重叠会产出一个退出码 0 的空安装包）。
