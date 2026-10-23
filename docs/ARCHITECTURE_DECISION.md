# ARCHITECTURE_DECISION — 正式架构决策（Phase 0 产出）

> 依据：`docs/OPEN_SOURCE_SURVEY.md` 的实测证据 + 目标机实测环境。
> 原则回顾：Open-source First, Architecture Controlled ／ 模块化单体 ／ Adapter 隔离 ／ 能同进程就同进程。
> 本文件是决策记录，不是教程。每条含「决定 / 理由 / 被否方案」。

---

## 1. 最终技术栈

| 层 | 选择 | 版本（实测） | License |
|---|---|---|---|
| 前端框架 | React + TypeScript + Vite | React 19.x / TS 5.x / Vite | MIT |
| 前端状态 | **Zustand** | 5.x | MIT |
| 图渲染 | **`@xyflow/react` (React Flow)** | 12.12.0 | MIT |
| 局部落图 | **`d3-hierarchy`（仅子树 tidy）** | 3.1.2 | ISC |
| 全局重排（可选、手动） | `elkjs` in Web Worker | 0.12.0 | ⚠️ **EPL-2.0 / GPL-3.0** |
| 后端 | **Node.js + TypeScript**（非 Python） | Node 24.18.1 | MIT |
| HTTP/WS | **Fastify + `@fastify/websocket`（`ws`）** | Fastify 5.12.7 / ws 8.22.0 | MIT |
| Event Bus | **emittery** | 2.1.0 | MIT |
| 存储 | **`node:sqlite`（内置）**，封装在单一 repository 模块后 | 内置 SQLite 3.53.1 | 绿鸿许可证 |
| 向量检索 | 见 §9（待回填；倾向 **暴力 cosine，不引入 ANN**） | — | — |
| LLM SDK | **`openai` 官方 SDK 走 OpenAI 兼容端点** | 7.34.0 | Apache-2.0 |
| 校验 | **Zod**（Graph Operation / LLM 输出 / 事件 payload） | 4.x | MIT |
| STT | **sherpa-onnx streaming Zipformer，独立 Python 进程（本仓库的薄 worker `services/stt-worker/stt_worker.py`）** | 1.13.8 | Apache-2.0（代码+模型） |
| VAD | **Silero VAD（由 sherpa-onnx 内建端点检测承担）** | v6.2.3 | MIT（代码+模型） |

**为什么主栈是 Node 而不是 Python FastAPI**：STT 已经必然是独立 Python 进程（sherpa-onnx），把编排/上下文/QA/MindMap 也塞进 Python 会形成"两个运行时各写一半业务"；而 TS 侧 LLM SDK 一线、React Flow 与前端同语言、类型定义可在前后端直接共享（`packages/shared`）。结论：**Python 只留在 STT worker，业务核心单一语言**。

---

## 2. 进程划分（3 个进程，不是微服务）

```
P1 浏览器 (React)
   AudioWorklet 16kHz PCM ──WS──► P2
   字幕 / MindMap / QA UI  ◄─WS── P2

P2 Node 主应用（模块化单体，唯一有状态的编排者）
   ├ AudioIngest → STT Adapter(WS client) ──localhost WS──► P3
   ├ Transcript Core + SQLite + Event Bus(emittery, 进程内)
   ├ MindMap Agent / Memory Agent / Context Manager / QA Agent
   └ Embedding worker（child_process，不阻塞主 loop）
        │
P3 Python STT worker（services/stt-worker/stt_worker.py：sherpa-onnx OnlineRecognizer + websockets，无业务逻辑）
```

- **P2↔P3 必须是独立进程**：sherpa-onnx 只能 Python/onnxruntime，且原生 addon 段错误会带走整个进程；进程边界 = 最便宜的故障隔离。
- **P2 内部一律同进程 + emittery**，不拆服务（设计文档 §5/§17）。
- **P2 内的 CPU 密集（embedding、必要时长文本 diff）走 `child_process` 而非 `worker_threads`**：理由是关键差异 —— worker_threads 里原生模块 segfault 会**连父进程一起死**，与「一个模块失败不得拖垮系统」冲突；child_process 崩溃可重启且不影响主 loop。

---

## 3. 数据流（关键路径与延迟预算）

```
Mic → AudioWorklet(f32, 48k) → 降采样 16k → Int16 PCM 100ms 帧
    → WS(二进制) → P2 → STT Adapter → P3
P3 → partial ─► Transcript Core(type=partial) ─► Event: transcript.partial ─► 仅字幕 UI
P3 → final   ─► Transcript Core(type=final)    ─► Event: transcript.final
                                                     ├─► SQLite 持久化 + Embedding
                                                     ├─► MindMap buffer（15–30s 或 4–8 段触发）
                                                     └─► Memory buffer（语音时间累计 3–5 分钟触发 SummaryBlock，见 §9.1 D-1）
User question → Context Snapshot(冻结) → QA Agent → LLM stream → 分块回 UI
```

预算与实测依据：
- 字幕 partial **§46 给的是两档预算：目标 <1 s、最大可接受 <2 s**（原文没有指定分位数，这一条歧义本身要记下）。**21 MB 小模型首个 partial 0.73 s**（Phase 0，实时节奏喂入）两档都达标；**511 MB 双语模型 2026-10-20 已单独复测**：37 分钟 1× 定速长跑、n=334，首个 partial **p50 0.936 s / p95 1.824 s / max 1.974 s**（§6.3 D-24）。**按 §46 的两档读：最大可接受档 334 条全数达成（离 2 s 上限只剩 26 ms，等于没有余量），目标档只有半数达成**（p50 0.936 ⇒ ≥50% 在 1 s 内，而 1 s 与 1.824 s 之间那一段的确切比例现有采样给不出——只报了三个百分位，没报阈值计数）。先前在这里写的"尾部超近一倍"是拿 p95 去比 1 s 单档，读错了预算。final 侧同时纠正了一条旧结论：先前记的"final 迟到 p50 0.95–1.81 s"是收尾样本，稳态下字幕定稿 ≈ rule2 的 0.8 s 判停窗口 + 约 0.05 s 处理（D-20 已就地标注推翻）。**所以模型选择的问题被改写成这样：双语模型在 §46 的字面预算内，但没有余量，且达成靠的是 p50 而不是每一条**——"要不要为把这个余量买回来而换 21 MB 小模型"仍是 §58(d) 的产品权衡，不由工程侧代答；而"双语模型中文准确率到底比小模型好多少"至今没有可信数字（语料仍是官方演示音频，见 R1）。
- 音频链路只 2 跳（浏览器→Node→Python），**禁止**任何模块在音频路径上同步等 LLM。
- QA 首 token **<3s**：约束为 provider 选择 —— 禁用 thinking-only 模型（实测 Kimi K3 TTFT≈3.56s 会打穿预算）。
- MindMap 15–30s：**不追求即时，稳定性优先**。

---

## 4. Canonical Schema（系统唯一内部协议，设计文档 §12–§13 的落地）

`packages/shared` 定义，前后端共用；第三方结构**永不**越过 Adapter 进入核心。

```ts
// —— 唯一的系统真相源 ——
interface TranscriptSegment {
  id: string; sessionId: string; text: string;
  startTime: number; endTime?: number;      // 相对 session 起点 ms
  confidence?: number;                      // `speakerId` 已于 2026-10-21 删除（§13 OPEN-9：零生产者零读者）
  type: "partial" | "final";
  createdAt: number;
}

interface MindMapNode {
  id: string; title: string; summary?: string; parentId?: string;
  sourceTranscriptIds: string[];             // 可追溯到原文，支撑引用跳转
  createdAt: number; updatedAt: number; confidence?: number;
}
interface MindMapEdge { id: string; source: string; target: string; relation?: string }

interface SummaryBlock {
  id: string; sessionId: string; startTime: number; endTime: number;
  summary: string; keyPoints: string[]; entities: string[];
  level: number;                        // 0 = 阶段摘要，>0 = 合并块
  parentBlockId?: string;               // §31 原字段：合并块的血缘锚点（第一个子块）
  sourceBlockIds: string[];             // 合并块的全部子块，见 §9.1 D-2
}

interface Session {
  id: string; title?: string; startedAt: number; endedAt?: number;
  status: "recording" | "paused" | "completed";
}
```

**partial 的四条禁令（设计文档 §14）实现为类型层 + 存储层双闸门**：`TranscriptStore.append()` 只接受 `type:"final"`；partial 走独立的内存 ring buffer 给字幕用，不进 SQLite、不进 MindMap、不进 Memory、不建 embedding、不触发总结。

---

## 5. Graph Operation（增量生长的唯一写入接口，设计文档 §18–§20）

```ts
type GraphOperation =
  | { type:"add_node";    node: MindMapNode;          opId: string }
  | { type:"update_node"; nodeId: string; patch: Partial<MindMapNode>; opId: string }
  | { type:"move_node";   nodeId: string; parentId: string;            opId: string }
  | { type:"merge_node";  sourceNodeId: string; targetNodeId: string;  opId: string }
  | { type:"delete_node"; nodeId: string;            opId: string }
  | { type:"add_edge";    edge: MindMapEdge;         opId: string }
```

写入链：`LLM raw → JSON parse → Zod schema 校验 → Graph Engine(纯 reducer applyOp) → Graph Store → UI`。

Graph Engine 必须校验并拒绝（拒绝=discard+log，**不抛穿整个 app**，设计文档 §45）：
1. **孤儿**：`add_node` 的 `parentId` 不存在 → 进 orphan buffer 等下一轮，不直接建到根下。
2. **环**：`move_node` 造成后代指回祖先 → 拒绝。
3. **幂等**：`opId`（由 LLM 响应 id + 序号确定性派生）重复 → 丢弃，防重试导致重复节点。
4. **顺序**：`updatedAt` 单调；晚到的旧 op 丢弃（防 race）。

**MindMap 去重三层（设计文档 §24）**：L1 字符串归一（小写、去标点、常见别名表）→ L2 embedding cosine ≥ 阈值 → L3 仅在 L2 落在灰区时才让 LLM 判语义合并。阈值需 Phase 3 用中英混合真实数据调。

**Single Flight（设计文档 §23）**：`inFlight:boolean`，tick 到来时若忙则**跳过（丢弃本次 tick，数据留在 buffer）**而不是排队 —— 保证请求有界、不堆积、不乱序。

---

## 6. Event Bus 契约与故障隔离（设计文档 §17/§44/§45）

选型 **emittery** 的决定性理由：**监听器抛错不会中断其他监听器**（全部执行完，错误聚合为 `AggregateError`）；而 Node 内置 `EventEmitter` 是同步 emit，一个监听器抛错会中断后续，且未处理的 `'error'` 事件**直接让进程崩溃**。这条差异正是本项目「模块故障隔离」的硬要求，不值得用自研 shim 去换零依赖。

```ts
interface BusEvents {
  "recording.started": { sessionId: string };
  "recording.paused" | "recording.resumed": { sessionId: string; at: number };
  "recording.stopped": { sessionId: string; durationMs: number };
  "transcript.partial": { segment: TranscriptSegment };
  "transcript.final":   { segment: TranscriptSegment };
  "mindmap.update.requested": { sessionId: string; reason: "timer"|"batch" };
  "mindmap.updated":   { sessionId: string; ops: GraphOperation[] };
  "mindmap.failed":    { sessionId: string; error: string; willRetry: boolean };
  "summary.updated":   { block: SummaryBlock };
  "question.created":  { questionId: string; text: string };
  "answer.started":    { questionId: string };
  "answer.completed":  { questionId: string; citations: {t:number}[] };
  "answer.rejected":   { questionId: string; reason: "busy"|"rate_limited"; retryAfterMs: number }; // Phase 8b
  "module.error":      { module: string; error: string; recoverable: boolean };
}
```

隔离七条（写进代码规范，非可选）：
1. 模块间**只经总线**，禁止跨模块直接函数调用 → MindMap 卡死不会反压 STT。
2. 每个订阅体自带 `try/catch` + `.catch()`，失败即 emit `module.error`/`mindmap.failed` 后 return。
3. 每次 LLM 调用必须带 `AbortController` 超时；超时后标记 graph stale，下个 tick 自然恢复。
4. LLM retry **上限 1–2 次**（设计文档 §45），指数退避，超了就放弃本轮而不是死磕。
5. 兜底 `process.on("unhandledRejection")` 只记日志，但设计上不该触达。
6. **入口必须有配额**：任何能被客户端反复触发的 AI 路径（QA 是唯一的），必须在做昂贵工作之前拒绝，且拒绝要落到那一条请求自己的事件上，不能只写进全局错误通道。见 §6.1 D-16。
7. **失败路径不得重新占用刚释放的工作**：批处理任务在调用模型**之前**把批次从缓冲区分出去，失败后靠重新计时而不是"缓冲还满着所以立刻再来一次"。否则模型一挂就是热循环，隔离做得再好也会把进程拖死。见 §6.1 D-18。

**录音保护不变量**（验收 Test E 的实现化）：MindMap/QA/Memory 任一模块失效都不能影响 STT/字幕/持久化。**注意这不是靠"kill 开关"实现的**——产品里没有这个开关，也不该有：真正的机制是 §6 隔离条 1/2（emittery 的 `allSettled` + 每个订阅体自带 try/catch）加上"失败路径不重新占用刚释放的批次"。验收方式见 §6.1 D-18：用真故障（provider 抛错、监听器抛错、真实 adapter 指向没人监听的端口）注入，而不是假设源码里的 catch 存在就够了。

### 6.1 稳定性落地决策（Phase 8）

**D-15 事件循环延迟成为常驻记录，而不是临时探针**
- §47 要求"记日志"，而 Test F / §9.2 D-12 / R4 全都以"主 loop 有没有被卡住"为判据。此前这个数字只在一次性 `.scratch` 探针里存在过 —— 探针会过期，结论不会。因此新增 `observability/loopDelay.ts`：`monitorEventLoopDelay({resolution:5})` 每窗口写一条 `metric:loop_delay`（`LOOP_DELAY_REPORT_MS`，默认 10s），`snapshot()` 非破坏性读出挂进 `/api/debug` 与调试面板，关闭时记最后一窗。
- 三条实现约束都是有原因的：采样 `unref()`，否则观测本身能让进程不退出；`report()` 与 `snapshot()` 分开，否则打开调试面板每 2 秒读一次就把 soak 的窗口切碎；只采样不干预，任何"延迟高了就降质"的策略都不属于这一层。
- **本机的仪器下限（必须写下来，否则 Phase 9 会把噪声当结论）**：空闲进程用 resolution 5/20/50 分别读出 **p50 15.60 / 31.15 / 62.19 ms**，恰好是 15.625 ms 的 1/2/4 倍 —— 即 Windows 时钟粒度。所以在 5 ms 分辨率下 **~15.6 ms 是"什么都没发生"的底噪**，不是卡顿；判读只能用相对量级（对照线程内摆法的 1881 ms，见 D-12），不能拿绝对毫秒当阈值。这也解释了 D-12 表里两种摆法的 gap 中位（7.2 / 8.0 ms）为什么几乎相同：中位由 tick 决定，**能区分的只有 p99 与最大值**。
- 仪器的有效性有对照：同一个 Node API 在 `.scratch/probe-inline-loop.mjs` 报 `loopDelayMean 382ms / max 1882ms`，在 `.scratch/worker-loop.txt` 报 `9.01ms / 144.8ms` —— 它能分辨出已知存在的侵占，所以它的"没分辨出来"才有意义。

**D-16 QA 入口加两道闸，拒绝走 `answer.rejected` 而不是 `module.error`**
- §3 的原文是"AI 请求不得排队堆积"。Phase 8b 之前只有并发上限（`MAX_CONCURRENT_ANSWERS = 2`），它能防"同时"，防不了"连续"：mock/快回答场景每次答案几毫秒就结束，客户端连按回车可以无限开出 `LLM 调用 + 一次查询向量推理`（实测单次 query 嵌入 50–62 ms，见 §9.4），真实 API 下就是一张没有上限的账单，也正是 Test F 点名要看的"AI 请求堆积"。
- 两道闸都在**任何工作之前**，且都是 O(1)：`admit(now)` 先看并发、再看 `QA_MIN_INTERVAL_MS`（默认 1500 ms）距上次**被受理**的时刻。顺序是刻意的——上下文快照和查询嵌入是一题的全部成本，"先算完再说不"省不下任何东西。有单测直接锁这条（`refuses before any of the expensive work`：连发 4 题只产生 1 次 search、1 次 stream）。
- **拒绝不是故障**：原来并发超限发的是 `module.error{code:"qa_busy"}`，而 §48 的错误面板是留给真故障的，把"闸门正常工作"混进去会稀释信号。更硬的问题是它没带 `questionId`——客户端那个气泡只会永远停在"等待回答…"，被拒绝的题和还在路上的题长得一模一样。新契约 `answer.rejected{questionId, reason, message, retryAfterMs}` 是对那一题的答复，前端据此把 `done` 置真并显示拒绝理由。
- `retryAfterMs` 诚实地区分两种拒绝：`rate_limited` 给出真实剩余毫秒；`busy` 无法预测槽位何时释放，只能给间隔余数（通常为 0），文案直说"有 N 个问题在回答中"。不做静默丢弃、也不做排队——排队就是把 §3 禁止的堆积从 LLM 挪进自己的进程。
- 观测：每次拒绝写一条 `metric:qa_rejected{reason,inFlight,retryAfterMs}`，`answer.rejected` 同时进总线计数，因此调试面板的 Event Bus 区块天然能看到被拒了多少。没有再加第三道"拒绝事件限流"：每条拒绝都被它自己那一题的发送速率约束，成本是几百字节 JSON，而真正要挡的是 LLM 调用本身。
- 实跑验证（`.scratch/qa-ratelimit.mjs`，日志 `.scratch/srv13.txt`，`QA_MIN_INTERVAL_MS=2000`）：同一 tick 连发 6 题 → `accepted:["q1"]`、5 条 `rate_limited retryAfterMs=1990`、`completed` 只 1 条、`moduleErrors: []`，字幕与 `loop_delay`（p50 15.3 / max 16.3 ms，即 D-15 的底噪）全程不受影响。

**D-17 重连的验收标准是"重新对齐"，不是"连上了"**
- §46 一句话里藏着三件事：退避重连、状态可见、断线期间的数据补齐。Phase 8c 之前只有第一件的骨架，而后两件在实跑里各暴露一个真缺陷：断线期间结束的那一题气泡永远停在"等待回答…"；以及本文件 §11 早在 Phase 0 就声称 `graph_positions` 保证"重载后图不能跳"，**但当时全仓库没有任何生产代码写过这张表**（`savePosition` 唯一的调用者是单测），也没有任何路径把它读回前端。ADR 里的验收声明与代码脱节，这件事本身就是要记的教训。
- **只持久化拖拽，不持久化布局**：`layoutGraph(state, known, pinned, collapsed)` 是纯函数，坐标是"当前树形状"的因变量。把它的输出整张存库，等于冻结一次计算结果——模型下一轮给那一支插入子节点，存下来的坐标立刻是错的，重连后反而把 Test B 要求避免的"整体跳一下"变成永久状态。所以持久化的边界就是**用户意图的边界**：`pinned` 只由 `onNodeDragStop` 产生，`graph.snapshot` 只回放 `pinned`，其余坐标由前端用同一套布局函数现算。
- `mindmap.node.moved` 必须做存在性守卫：客户端是远端监听者，它手上那个 id 可能已经被自己这一侧的图删掉了。不检查就写库，留下的是一行比节点活得久的孤儿坐标。
- **回答不重放，因此必须就地关闭**：服务端重连时重放 transcript 与 graph，但不重放 `answer.*`（token 已经流过去了，重放意味着重复计费与重复气泡）。所以在 `session.snapshot` 到达时把所有 `done=false` 的回答判死，前端文案直说"连接中断时这一题的回答没能送达，请重新提问"。如果 token 后来又到了，`answer.completed` 会照常覆盖那句提示——这条自愈路径比新增一个 `interrupted` 标志便宜，也不引入第二种"结束"语义。
- 状态要能区分"第一次拨号"和"第 N 次失败"：`重连中（第 N+1 次尝试）` / `已断开（已重试 N 次）`，2 次之后转 `bad` 语气。旧 UI 只有一种"连接中"，于是一次都没有成功的进程崩溃，看起来和正常的初始化完全一样。
- 断线状态机第一次有了测试（`connection.test.ts`，8 例，用假 `WebSocket` 驱动真模块）。三条只有跑起来才会撞到的：被替换的旧 socket 必须彻底静默（否则两棵树各自收敛到不同坐标）；`disconnect()` 要清掉所有 handler，否则手动断开之后定时器还在拨；**CONNECTING 态的 `close()` 是无效调用**，socket 会"复活"并把帧投进已经废弃的连接，所以得等 `open` 再关。
- 实跑验证（`.scratch/rcc-8c.sqlite`，日志 `.scratch/srv8c.txt` + `srv8c-restart.txt`）：真实浏览器 + 真实服务端发出 `{x:1234.5,y:321.25}` → `/api/session` 里 `positions` 恰好只有被拖的那一个节点，`pinned:true`；整页重载后该节点渲染在 `translate(1234.5px, 321.25px)`，它的四个子节点全部落在 `x=1470.5`（= 1234.5 + NODE_W+COLUMN_GAP = 236，即锚点随拖动者走），而**未被触碰的另一棵树仍在 `x=0`** —— 这正是 §8 锚点语义想要的结果，第一次有了视觉之外的证据。杀掉服务端进程：徽章按 3→4 次爬升，实测第 3、4 次之间等待 4.0 s，与 1s/2s/4s/8s 阶梯吻合（8 s 上限由单测断言，不在浏览器里干等）。重启后 `link=open`、`reconnectAttempts=0`、8 个节点与 `pinned` 全部保留、`droppedFrames=0`、`errors=[]`。
- 一条已知边界（不作为缺陷修）：如果**服务端进程**重启，新连接没有 `runtime`，因此不下发 `session.snapshot`，前端会继续显示上一场录音的导图，而 `sessionId=null`、`recording="idle"`。它在下一次"开始录音"时被 `reset()` 清掉（有单测）。要真正解决需要"选择/恢复历史会话"的界面，那是 §53 之外的产品能力，不在稳定性阶段顺手半成品化。

**D-18 Test E 从"源码里有 catch"升级为"注入真故障的验收"**
- §6 的录音保护不变量此前只有一条单测（MindMap 模型不可用），既没有覆盖 QA / 检索 / 监听器这三类故障，也没有回答 Test E 真正关心的问题：**故障会不会绕路打到音频路径上**。`faultIsolation.e2e.test.ts`(4) 补的是这四条，每条都断言"字幕与库里的 final 一条不少"，而不只是"没崩"。
- **失败路径不能把刚释放的批次再吃进去**：`runFlush` 在调模型之前做 `batch = this.buffer; this.buffer = []`。顺序反了的话，`finally` 里"缓冲够了就再 flush"会立刻拿同一批重试，模型一挂就是热循环——这才是 Test E 唯一可能变成 Test F 灾难的地方。有断言锁它：整场故障风暴里 `structuredGenerate(task="mindmap")` 次数 **恰好等于** `mindmap.update.requested` 次数，一次不多。
- 故障风暴必须**止于 stop**：会话 dispose 后连续两次采 `bus.snapshot()`，中间等 400 ms，事件计数零增长。这条是给 Phase 9 的 30–120 分钟预跑的——遗留定时器 + 坏模型 = 无限请求。
- 三类故障各自的"应当发生"是不同的：QA 流式失败→ 该题 `degraded:true` 且**只有** `qa` 报错；索引死掉→ 答案照样从热上下文给出（`degraded:false`），但 `embed_failed` 与 `search_failed` **都要报**（静默返回空命中会把"增强丢了"伪装成"没问题"）；监听器抛错→ `handler_failed` 每事件一条、归因到那个模块而不是总线。
- **实跑发现并修掉了一个真缺陷**：模型故障时答案文本为空且 `done=true`，而 `AskAiPanel` 的"结束但没内容"分支只有一句"连接中断时这一题的回答没能送达"——把服务器自己报的 `degraded` 伪装成了网络问题，用户会去查根本没坏的网线。修法是把它拆成 `answerBody()`（`format.ts`，纯函数，7 条单测）：拒绝→正文→模型失败→断线丢失→等待，四句分开。浏览器里对着坏掉的真 adapter 提问，实测渲染出的是"模型没能给出这一题的回答，请重试。"
- 实跑验证（`.scratch/test-e-live.mjs`，日志 `.scratch/srv8d.txt`）：故障注入**不需要任何新代码**——`MOCK_LLM=false` + `LLM_BASE_URL=http://127.0.0.1:9/v1`（无人监听的端口）+ `LLM_TIMEOUT_MS=1500`，真实 openai-compatible adapter 每次都真的失败。结果：8 条 final 与 24 条 partial 全程没断，字幕间隔在故障前/后分别是 max 1260 / 1492 ms（mock 节奏本身 ~1.25 s，即无可测影响）；`module.error` 恰好 4 条（`qa/answer_failed`、2×`mindmap/update_failed`、`memory/summary_failed`）；`undecodable: []`；stop 后事件计数零增长；`loop_delay` p50 15.6 ms 就是 D-15 的底噪。
- 两条判读注意事项：`/api/debug` 的 `mindmap/memory/retrieval` 三个 gauge 在会话 dispose 后回到全 0（`recording.elapsedSec` 却还留着上一场的时长），别把"indexed: 0"当成索引坏了——同一场跑到中途再采样是 `indexed: 5`，正常写入；以及测试替身**不能 `{...instance}`**，类实例的方法在原型上，展开只会复制字段，第一版测试因此把 MindMap 和 Memory 一起报错了，那是替身的故障不是产品的。

---

### 6.2 长跑落地决策（Phase 9）

**D-19 Test F 的 31 分钟实跑：判据逐条怎么被证实，以及哪一条本环境证明不了**
- 设计文档 §56 的 Test F 原文只有两句：`运行至少：30 分钟` 加 `没有：严重内存泄漏 / Transcript 丢失 / MindMap 大量重复 / UI 明显卡顿 / AI 请求不断堆积`。**（2026-10-21 更正：本条此前写作"§56 把 Test F 定为『≥30 分钟（最佳 60–120）连续运行：无内存泄漏、无节点丢失/重复、UI 不卡顿、AI 请求不堆积』"，两处不实。① "最好继续测试：60～120 分钟"在 §53 Phase 9，不在 §56；② 原文的五条否定项被我并成四条，把"Transcript 丢失"与"MindMap 大量重复"合成一句"无节点丢失/重复"，恰好把更要紧的那条——转写不许丢——读没了。所以本轮 60 分钟复跑满足的是 §53 的"最好"，不是 §56 的"至少"，两个层级不许再混引。）** 这五条全是**斜率**而不是快照，所以先决条件是 Mock Mode 能连续供speech：`MOCK_STT_REPEAT`（`env.ts`，默认 1＝发布形态播一遍，0＝播到停）把 79 秒脚本变成无限源，`MockSTTProvider` 改成**逐趟惰性链式排程**（排完一趟才排下一趟，延迟全部改成相对该趟起点），segment id 用 `pass * 8 + index` 编号，节点标题按趟加 `·N` 后缀。本次跑的是 `MOCK_STT_SPEED=1 MOCK_STT_REPEAT=0`，31.03 分钟真实时间。
- **两个 bug 在开跑之前就被针对性单测抓住**（这条决定值得记的是顺序，不是结果）：① 早先的续趟排程用绝对时间，第 N 趟整整晚一趟才出声；② `MockLLMProvider` 的节点 id 取标题的 10 位 hex slug，而「世界模型」与「世界模型·2」前 15 个 hex 字符相同——图门控把第 2 趟之后的每个节点当重复丢弃，导图**长到 8 个就停住**。修法是 `nodeIdFor(line, pass)` 加 `-pN`，回归锁是 `pipeline.e2e.test.ts` 的"keeps growing the map across repeated passes"（断言 3 趟＝24 final＝24 节点，且每个节点的父节点同趟）。如果不先写这条测试，这 31 分钟会跑出"节点数永远等于脚本长度"的漂亮假象。
- 为了跑这场，观测面补了两处（都不是新功能）：`/api/debug` 增加 `process.{rssBytes,heapUsedBytes,externalBytes}`，因为"无泄漏"必须和队列深度在同一张采样面上，而不是只存在于 profiler 会话里；`bus.snapshot()` 增加 `listeners`/`errorListeners`（emittery 的 `listenerCount()` 无参即全局总数），因为**本项目的泄漏形态就是监听器**——每个 WS 连接注册 16 个、会话运行期注册 3 个，`events` 计数器完全看不见它。`eventBus.test.ts` 新增一条把它锁住：订阅两个再取消，`listeners` 必须**回到基线**（只涨不降才是泄漏）。
- **无泄漏**：heap 25.7 → 28.9 MB（区间 25.3–28.9），斜率 0.093 MB/min；rss 76.6 → 81.1 MB；external 6.1 → 6.3 MB（几乎不动，说明没有原生侧累积）。`listeners` 从 19（soak 客户端连上）到 35（浏览器连上）之后**连续 30 分钟钉在 35**——期间发生 188 条 final、74 次 MindMap 批、10 个摘要块、20 轮问答，一次也没有增长；而且浏览器中途重载了两次，每次 `listeners` 都是先回 19 再回 35，说明 socket 关闭真的把 16 个监听器摘掉了。**判读注意**：3.2 MB 的 heap 增量对应 188 条被有意保留的数据（final + 节点 + 1024 维向量），约 17 KB/条，量级正好——所以这条只能证成"增量与留存数据成正比"，**不能**证成"绝对无泄漏"：Mock 模式下图与索引本来就全量驻留内存，要区分"留存"与"泄漏"必须要么跑足够久看曲线拐点，要么做 heap snapshot diff。把这句话写在这里，是为了以后不许拿这条斜率当"已证明无泄漏"。
- **无节点丢失/重复**：客户端侧 `dupAddNodeIds: []`、`orphanParents: []`；`frames` 里 `transcript.final 188 = mindmap.node.upserted 188`；库里 `segments 188 = nodes 188 = operations 188 = embeddings 188`；188 = 23.5 趟 × 8 行，与 31.03 分钟严丝合缝（脚本跨度 79 s）；`mindmap.skipped` 与 `retrieval.dropped` 均为 0，`retrieval.indexed` 收尾 188 即一条没漏进索引。字幕间隔 p50 10 002 / p95 13 001 / max 13 016 ms——脚本本身的 max 间隙就是 13 s，即 31 分钟后节奏误差 16 ms。
- **AI 请求不堆积**：`mindmap.update.requested` 74 次＝2.38 次/分，正是 `MINDMAP_MAX_INTERVAL_MS=25000` 的上界；每个 30 s 采样窗的增量都是 1–2 次。队列深度全程 `mindmap.pending ≤ 3`、`retrieval.pending = 0`、`memory.pending` 在 0–24 之间随窗口起伏（这是 240 s 窗的正常锯齿，不是积压）。问答侧 20 问 20 答、`degraded 0`、`answer.rejected 0`、TTFT 0–1 ms、流式 2548 token，`answersInFlight` 最大值 **0**——每 90 s 一问远未触及 1.5 s 准入闸，所以这一条测的是"不会被自己堆死"，不是"闸门能用"（闸门由 D-16 的单测覆盖）。
- **事件循环**：`loop_delay` p95 从 16.5 → 16.7 ms 全程平直（15.5 ms 是 D-15 记过的采样底噪），31 分钟里最差一窗 p95 24.9 / max 90.8 ms，出现在第 12 分钟；另有三窗 max 40.9–48.7 ms。90.8 ms 这一次**没有**转成字幕卡顿（同窗 final 间隔仍是 13 s 量级），也没有对应任何 `module.error`。它的可疑点是内存折叠批与 GC 同时发生，但本环境无法把 GC 归属到毫秒，故只登记现象、不写成结论。
- **UI 不卡顿：一半能证，一半本环境证不了。** 能证的是数值：生产构建（`vite build` + `vite preview`，不是 dev 模式）里 rAF 帧间隔 p50 16.7 / p95 16.9 / p99 17.1 ms，>50 ms 的帧 1 次、>200 ms 0 次，`PerformanceObserver('longtask')` 全场只记到 1 条 95 ms——而那条正是探针自己 `stats()` 排序 9 万个浮点造成的，**产品侧长任务为 0**。DOM 侧节点数与服务器 `nodeCount` 同步（15→134 一路对上），字幕条目 37→187 增长，折叠/展开点击有效。证不了的是**连线**：这一页在第 12 分钟后 `visibilityState` 变成 hidden 并且不再出画（本环境无原生 viewport，`take_screenshot` 直接失败），此后 `.react-flow__edge` 归 0、`.react-flow__edges` 里没有 `<svg>`、点 fitView 变成 `translate(0,0) scale(1)` 空操作。React Flow 的连线渲染与 fitView 都依赖绘制期的节点测量，页面不出画就没有测量——所以这是**环境边界而不是产品缺陷**：同一场跑到 71 节点为止连线一直正常（11→24→39→53 随节点数增长），且数据层当场可证完好（库里 114 节点 85 个有父、**悬空父 0**；新开的 WS 直接读 `graph.snapshot` 拿到 119 节点 89 个 parentId；折叠能藏掉 5 个子节点即 `childOrder` 正确）。**因此 R3 的"500/1000 节点 FPS 基准"不能算过**，它必须在真实窗口里跑，见 §13 OPEN-5。**（⚠️ 这一格的环境结论已于同日由 D-26 解除：改用操作系统里已装的 Edge 无头实例 + CDP 后，基准在真出画的 1440×900 页面上跑成了，1163 节点下交互全程 17 ms p99、零超限。本节保留原文是为了记录"当时为什么判不了"，性能结论请以 D-26 为准。）**
- stop 之后依旧静默：连续两次 `/api/debug` 相隔 3 s，`bus.events` 完全相等，`listeners` 35→16（只剩浏览器那条 socket），`recording.state` 两次都 idle——D-18 那条"故障风暴止于 stop"在真实进程里同样成立。
- 顺手发现并修掉一个**真实数据丢失**：`mindmap_edges` 有读（`hydrate()`）、有删（`deleteNode`）却没有任何写入，而 `add_edge` 确实在 MindMap prompt 的六种允许操作里——模型提出的横向关联会活着到进程重启，然后永久消失。现在 `GraphStore.applyOps` 每批把内存态边集整组镜像回表（层级关系仍然只存 `parent_id`，不重复入库），并有单测断言"重启后边还在"。同时暴露出 §11 那段 schema 是按设计文档 §40 的设想写的（`seq/valid/reject_reason` 三列根本不存在），soak 脚本照抄文档立刻报错——已按 `sqlite.ts` 全量改正，详见 §11。
- 复现路径与产物：驱动 `.scratch/soak.mjs`、启动器 `.scratch/launch-soak.mjs`（后端与驱动都必须 **detached** 起进程，智能体的单条命令上限是 10 分钟，比 31 分钟短——这条环境约束值得记，否则下一次会先被工具掐掉再当成产品问题查）、分析器 `.scratch/analyze-soak.mjs`（最小二乘斜率 + 队列峰值 + 采样表）、样本 `.scratch/soak-samples.jsonl`(62 行)、收尾汇总 `.scratch/soak-out.json`、库 `.scratch/rcc-soak31.sqlite`。本次只跑满最低 30 分钟，60–120 分钟的最佳区间未覆盖，记在 §13。

**D-26 R3 的 500/1000 节点基准终于跑成了：结论不是"会不会掉帧"，而是"掉的是哪一帧"——60 Hz 交互全程稳如磐石，痛的是新节点要 0.3 s 才出现**（2026-10-20，接 D-19 未完项"大图标尺"；编号按时间）
- **先解决"没有会出画的浏览器"这件事，而且没有为此新增任何依赖**。D-19 的边界是智能体内置视图：`visibilityState` 中途转 hidden、不再出画，React Flow 的连线与 fitView 依赖绘制期测量，于是 `.react-flow__edge` 归 0——那不是产品缺陷，但也因此**在这台机器上任何大图标尺都测不了**。破法是把"要测量的东西"和"提供测量的东西"分开：直接用**操作系统里已装的 Edge 155 以 `--headless=new` 起一个真浏览器**，用 CDP（`Target.createTarget` + `attachToTarget(flatten)` + `Runtime.evaluate(returnByValue, awaitPromise)` + `Input.dispatchMouseEvent` + `Page.captureScreenshot`）驱动它。CDP 客户端是自己写的约 120 行，跑在**已经登记的 `ws` 依赖**上——所以 Rule 4 的账是零：没有新增第三方包、`package.json` 没动、`THIRD_PARTY.md` 不需要新条目。要诚实补一句：Edge 是**测量工具而不是产品依赖**，它的版本没有钉在任何地方，所以脚本把 `browser: Edg/155.0.4283.62` 打进每一跑的首行日志（D-20 那条"参数漂移"教训的直接应用）；换一台机器/一个内核版本，这组数不能跨机比较。**这个 headless 实例是真出画的**，两条独立证据：`visibilityState: "visible"` + rAF 稳定 ≈61 Hz（1440×900、dpr 1），以及 `check-dom.mjs` 在 `bench=40` 下数到 `edges=34 / edgePaths=68` 且首条边 HTML 是真实的 `<g class="react-flow__edge react-flow__edge-smoothstep" …>`，截图非空白。
- **种子路径（D-19 说"没有它就永远不可复现"的那件前置）落在 `packages/frontend/src/dev/benchSeed.ts`**：`?bench=N` 在 `createRoot` 之前安装（这样 React Flow 挂载期的 `fitView` 框住的是已种好的图，而不是它起手那张空图），用 32 位 LCG `(state*1664525+1013904223)>>>0` 生成**确定性**拓扑（同 N 永远同一张图，与 `.scratch/bench-scan.ts` 同一手法，不引 faker）：6 个顶层根、深度上限 4、父节点必早于子节点、`opId` 唯一、N 夹到 `MAX_BENCH_NODES=2000`（`?bench=1e99` 也只会种到 2000，不会把浏览器打死）。5 条单测锁住解析/夹取/确定性/拓扑不变量，其中一条专门断言 **500 个节点在真实 reducer 上跑完 `staleOpIds` 为空**——即基准喂的是合法批次，不是靠门控丢数据凑规模。
- **这条路径是纯客户端的，这是设计而不是缺陷**：它不建会话、不写行、不发 `mindmap.node.upserted`，所以 `/api/debug` 的 `nodeCount` 在基准全程保持 0。谁要是把它当"数据没落库"的 bug 去修，就会顺手把基准变成后端压测。代价也说清楚：基准期间拖动的节点**存不下来**（没有 session 可以 upsert `graph_positions`）。
- **它有意被打进生产包**（`main.tsx` 无条件调 `installBenchSeed()`，只由 URL 参数决定生效）：D-19 定过一条规矩——性能数字必须来自 `vite build` + `vite preview` 而不是 dev 模式，否则测的是未压缩、未打包的另一种形状。把它包进 `import.meta.env.DEV` 就等于让基准只能测 dev 构建，那组数不再对应交付物。代价实测是 `index` chunk 从 29.12 kB 涨到 30.08 kB（gzip 10.10→10.54 kB），且**任何拿到生产页面的人加个 `?bench=2000` 就能种出 2000 个假节点**——这是纯客户端的内存自伤，不触碰后端、不写库、不影响别人的会话，MVP 阶段接受。若将来这东西上线给多人用，正确的收法不是 DEV 开关而是把它挪进一个只有内部路由才 import 的模块。
- **两个规模的数（原文照抄，不做四舍五入的美化）**：
  - `bench=500`：出画 `first node painted 727 ms`；交互前 DOM `{nodes:500, edges:494, paths:988, viewport:"translate(286.5px, 518.938px) scale(0.25)"}`；收尾 `{nodes:663, edges:657}`；帧节奏 idle `n=299 p50/p95/p99=17 max=67 over50=1 over200=0`、zoom `n=90 p50/p95/p99=17 max=17 over50=0`、pan `n=54` 同上；`grow-by-20` 同步阻塞 `[6,7,5,6,6,4,4,9]` ms、`applyOps→2nd rAF` `[212,177,14,159,65,13,177,73]` ms（**双 rAF 底噪本身只有 18 ms**）；生产批次形状 `grow-by-ONE` 的 `sync/paint` = `1/11`、`1/185`、`2/75` ms；长任务 12 条 `[106,84,114,241,155,133,151,151,171,163,182,184]` ms；heap `23.9 MB of 145.8 MB`。
  - `bench=1000`：出画 `996 ms`；交互前 `{nodes:1000, edges:994, paths:1988, scale(0.25)}`；收尾 `{nodes:1163, edges:1157}`；idle `n=301 p50/p95/p99=17 max=17 over50=0 over200=0`、zoom `n=95`、pan `n=59` **全部 17 ms、零超限**；`grow-by-20` 同步 `[10,12,10,8,10,10,8,13]` ms、`applyOps→2nd rAF` `[362,27,291,126,18,347,190,25]` ms（底噪 25 ms）；`grow-by-ONE` = `2/106`、`2/14`、`6/327` ms；长任务 20 条，最大 `[256, 349, 326, 278, 268, 265]` ms；heap `152.7 MB of 200.4 MB`。
- **判读：R3 担心的那一维（"数百到上千节点时可能掉帧"）在 1163 节点上被证否**。滚轮缩放 20 档、拖拽平移、5 秒空转三个阶段共 455 帧，**p50/p95/p99 全是 17 ms，>50 ms 的帧 0 次**。所以"迁移 Cytoscape/G6 Canvas"这条降级阶梯**没有实测依据**，不许再当成待办风险挂着。
- **但同一批数据把真正的缺陷指出来了，而且它不在交互那一维**：每批 `applyOps` 的**同步**部分（reducer + `layoutGraph` + d3 布局）只有 4–13 ms，可 `applyOps→下一次绘制` 却是 18–362 ms。差值全是 React 的协调与提交——`buildFlow` 每批为**每一个**节点新建对象（`MindMapView.tsx` 的 `useMemo` 依赖 `graph/positions/collapsed`），React Flow 因此拿到一个"全部引用都变了"的数组，把 1163 个节点整体重渲染一遍。后果是用户可感知的：**生产批次形状下，加一个节点实测要 14 / 106 / 327 ms 才出现在屏幕上**，长任务 256–349 ms 就是这段时间。**所以 §56"UI 不卡顿"在大图下的真实威胁是"新节点迟到 0.3 秒"，不是"拖动不跟手"。**（⚠️ 这一句成立，但同一段里"差值全是 React 的协调、因为 `buildFlow` 每批新建对象"那句根因**已被当晚的实验推翻**，见本节末的 D-26 同日更正：我们自己的代码只占 4–9 ms / 100–400 ms。）
- **顺手测出一条 §58(d) 的界面后果**：`minZoom={0.25}` 把 fitView 夹死了——N≥200 之后每一跑的 viewport 都停在 `scale(0.25)`，也就是**图越大越"框不住"**，1000 节点的整棵树在 1440×900 下上下都溢出（`.scratch/bench-1000-fit.png` 可直接看到）。这不是性能问题，是"我到底在哪"的导航问题；`onlyRenderVisibleElements` 与默认折叠（R3 阶梯的第一级）现在有了数据支撑，但**本决定没有顺手实现它们**——它们会改变用户看到的地图形状，属于 §58(d)。
- **heap 那一格不许当结论用**：663 节点 23.9 MB、1163 节点 152.7 MB，而重复跑同一规模的波动区间是 24–152 MB，比规模差还大。原因大概率是采样点相对 GC 的位置，但**没有验证过**，所以这里拒绝给出"每节点约 X KB"这种看似精确的换算。要量化内存得按 D-19 的斜率法（同一规模连采多点看趋势），不是抓一次快照。
- **三条测量卫生的坑，每一条都曾产出一个假数字**（写在这里是因为它们比结论更容易复发）：① 探针的 rAF `tick` 忘了 `last = now`，空转 p50 报出 **2937 ms** 这种荒谬值——第一反应应该是"我的尺子坏了"，不是"产品卡成这样"；② 在批次重建的中途查 DOM，`edges` 报 0，看起来完全像 D-19 那个环境缺陷的复发，实际是查得太早，改成**先静置 400 ms 再查 + 交互前单独快照一次**才拿到 657/1157；③ 用"双 rAF"当等待本身要 18–25 ms，不把它单独量出来并减掉，`grow-by-20` 的数就全是尺子读数。**另外记一条我自己的操作事故**：清理测试浏览器时用过 `taskkill //F //IM msedge.exe`，那会杀掉本机**所有** Edge 实例而不是我起的那一个；正确做法只有 CDP `Browser.close` 或 `taskkill //PID <pid> //F`。
- **复现**：`npm run build -w @rcc/frontend` → `npx vite preview`（生产构建，不是 dev 模式——D-19 定的规矩）→ 后端 `MOCK_*` 起在 8787 → `node .scratch/bench-flow.mjs 500`／`1000`。产物：`.scratch/bench-{500,1000}.png`、`.scratch/bench-{500,1000}-fit.png`、日志 `.scratch/bench-out-{500,1000}.txt`。CDP 客户端 `.scratch/cdp.mjs` 只连 `127.0.0.1`，注入脚本在首次导航之前完成（`Page.addScriptToEvaluateOnNewDocument`），否则丢掉的将是挂载期那一帧。
- **仍未覆盖（不许因为基准跑成就当成 OPEN-5 全关）**：① Test F 的**最佳 60–120 分钟**区间——本次是每跑约 2 分钟的图标尺，与时长压测是两个维度；② 真实语料下"批次大小 × 图规模"的二维表——`grow-by-20` 是人为批次，MindMap 实际每批 1–8 个节点，上面 `grow-by-ONE` 那一列才是贴近生产的形状，而它只有 3 个样本；③ 折叠/`onlyRenderVisibleElements` 阶梯的实际收益，只登记了"该不该做属于 §58(d)"，没测做了之后省多少；④ DPR>1 与真机窗口（headless 是 dpr 1，核显的实际光栅化压力可能更高）。

**⚠️ D-26 同日更正（2026-10-20 深夜）：上面那条"差值全是 React 协调、根因是 `buildFlow` 每批新建对象"是推断，实验把它推翻了；缓存已写、已测、已撤回**
- **先说做了什么**：按那条根因写了一个按 id + 值签名复用的节点/边缓存（含 7 条单测，锁住"未变分支保持对象引用""改动的节点拿到新值""删除的节点从缓存里消失"）。**改完复测，paint 一格都没动**：`grow-by-ONE` 从 `106/14/327` 变成 `126/20/113`，`grow-by-20` 从 `[362,27,291,126,18,347,190,25]` 变成 `[136,21,152,31,304,114,21,402]`——同一量级，同一抖动。**于是把代码整体撤回**，`index` chunk 的构建哈希回到改动前的 `index-C0nAyV0R.js` / 30.08 kB，逐字节一致，`check-dom.mjs` 复核 `bench=40` 仍是 `nodes 40 / edges 34 / edgePaths 68`。留下的只有这个脚本 `.scratch/memo-rate.ts`。
- **为什么必然没效果，两句话**：① **命中率本身就是 0%**——`grow-by-20` 把新节点撒在 6 棵顶层树上，每棵都重新 tidy，于是 1163 个节点的坐标**全部**变化，缓存一个都复用不到（实测：跨树 0.0%、单树 62.2%、钉住的分支 93.9%）；② 但即便把复用做到 94%，paint 还是 113 ms——**说明瓶颈不在对象引用**。
- **把 200 ms 拆开看它到底是谁的**（`.scratch/buildflow-cost.ts` 在 Node 里单测我们自己的派生，`.scratch/bench-profile.mjs` 用 CDP `Profiler` 采 6 个批次、4162 ms 窗口、6304 样本）：1163 节点下 `layoutGraph` 1.0–2.9 ms、`visibleNodes`+map 0.3–0.7 ms、全量 `JSON.stringify` 0.8–2.3 ms，**我们写的全部代码约 4–9 ms/批**。同一时刻浏览器报 paint 100–400 ms。CPU profile 的自身耗时排序折算成每批：浏览器非 JS 工作 `(program)` **≈231 ms**、React 协调 ≈55 ms、React Flow 内部 ≈43 ms、GC ≈30 ms、`setAttribute`+`getBoundingClientRect` ≈18 ms、**我们自己的 bundle ≈10 ms**。也就是说**这个项目能改的那一份只占总延迟的 3–5%**。
- **两个候选解释也各自被实验否掉了一半**：把 `<ReactFlow edges={[]}>` 之后 paint 只降约三分之一（`grow-by-20` 最大 402→246 ms），边不是主因；开 `onlyRenderVisibleElements` 之后 **DOM 里的节点从 1163 掉到 29 个，paint 反而稳定在 233/225/229 ms**——所以也不是"每个节点一份 DOM"的排版成本。**结论：这 200 ms 的归属仍未确定**，能确定的只有"不在我们代码里、不在可见 DOM 数量里、不在边的数量里"。把这句写在这里，是为了下一个想动它的人不必再走一遍这三条死路。
- **因此 R3 的陈述要再改一次**：昨天写的"大图下新节点迟到约 0.3 s，缓解是 `buildFlow` 的引用稳定性"作废——缓解不在引用稳定性。同时**也不能反过来断言"该换 Canvas 渲染层"**：`(program)` 占一半说明大头是浏览器渲染，而 `onlyRenderVisibleElements` 把 DOM 压到 29 个节点都没让它变小，说明"少一些 DOM"这条 Canvas 的核心卖点在本机没被证明有效。**这一格现在是未知，不是待办**。
- **顺带查清了一件与性能无关的正确性事实**（否掉了我自己提的两个怀疑）：`toggleCollapsed` 是 zustand `create` 回调里建的 action，身份恒定，所以旧代码 `data.onToggle = () => toggleCollapsed(node.id)` **不会**捕获过期闭包；`childCount` 与 `collapsed` 在同一次 `visibleNodes` 映射里读出，批内不可能不一致。**真正存在的正确性缺口是另一件事**：`useEffect(() => setNodes(flow.nodes))` 每批都会覆盖 React Flow 的内部位置，而 `pinNode` 只在 `onNodeDragStop` 才写——所以**一次 flush 落在拖拽中途会把正在拖的节点弹回原位**。缓存修不了它（跨树批次 0% 复用），登记为 §12 之外的新待办。**（已于 2026-10-21 由 D-27 修掉：`MindMapView.tsx` 的 `draggingId` 闸门，并用 `.scratch/drag-batch.mjs` 在同一页面上量出"弹回 168 px"→"0 px"。）**
- **测量卫生的第四条**（与上面三条并列）：**"改了就该更快"不是证据**。这次我先写下根因、再照根因改、再复测——如果只跑单测（7 条全绿，它们测的是"引用复用对不对"）就会当成修好了。是复测那一格把它拦下来的。

---

### 6.3 真实 STT 落地决策（Phase 5）

**D-20 worker 是我们写的 300 行薄进程，不是 sherpa "自带的 websocket server"**
- **先记一条文档纠错**：本文件 §1 技术栈表、§2 进程图与 `THIRD_PARTY.md` §1、`OPEN_SOURCE_SURVEY.md` §1 早在 Phase 0 就写着"用其自带的 `sherpa-onnx-online-websocket-server`"，那条说法来自 README 的二手印象，落地时查证**不成立**：GitHub release 资产里没有这个可直接运行的文件，本机安装的 `sherpa-onnx==1.13.8` wheel 里 websocket 相关文件名**一个都没有**，唯一 console script 是 `sherpa-onnx-cli`（还要额外 `pip install click`）。真实可依赖的公开面是 `OnlineRecognizer` 这个 Python API，所以本项目自己写了 `services/stt-worker/stt_worker.py`（约 300 行，只调用未修改的公开 API）把它变成一个本地 WS 服务。这仍然是 Rule 1 里的**本地服务**层级——识别算法一行都没自研；被否的替代是"为一个进程外调用改去 fork 整个 sherpa"。**教训**：选型表里"自带 server / 零二次开发"这类词必须落到一次可复现的下载或 import 验证上，否则它是愿望不是证据。上述四处正文均已按实测改写。
- **协议 v1**（唯一的跨进程契约，写在 worker 顶部与 Adapter 的 zod schema 两处）：下行是二进制 PCM s16le 单声道 + 文本 `{"type":"flush"}`/`{"type":"ping"}`；上行是 `ready` / `partial` / `final` / `flushed` / `pong` / `error`。**`seq` 是一条 utterance 的编号，它的 partial 与 superseding 的 final 共享同一个 `seq`**，Adapter 把它翻译成 `<sessionId>-live-<seq>` 的 segment id——于是 `TranscriptCore` 现有的按 id 去重天然做到"final 替换 partial"，不需要第二种机制。Adapter 侧对每一帧做 schema 校验：同一台机器上的进程也不能把没校验过的载荷送进核心（§51）。
- **两个不能用/要绕的 sherpa 事实**（都是实测，不是推测）：① 1.13.8 的 `get_result(stream)` 返回的是**纯字符串**而不是带 `.text` 的结果对象；② `recognizer.start_time(stream)` 会**领先于已经喂进去的音频**——自测里出现过 `startSec 7.22 > endSec 4.6` 的段，拿它当段首会引用到还没说到的时刻。因此段首取"上一个端点的位置"、段尾取当前样本时钟并 `max(now, segment_start)`，代价是段边界粗但单调，足以支撑 §33 的 `[mm:ss]` 引用。`from_zipformer2_ctc()` 不接受 `max_active_paths`（只有 transducer 路径接受），也是撞出来的。
- **端点规则**（CLI 默认，可覆盖）：rule1=2.0 s 长静音收尾、rule2=0.8 s 已有 token 后的静音、rule3=20 s 单条硬上限。rule2 直接决定了字幕延迟的下界（见下）。
- **实测数字**（int8 权重、`--num-threads 4`、本机 Intel Iris Xe 核显机型）：`--selftest` 非限速 RTF greedy **0.126** / modified_beam_search **0.168**，即 6–8× 实时。**这与 Phase 0 登记的 0.034–0.037 不一致**——那一组是在纯 recognizer 循环里测的，没有走 per-chunk 的 Python 往返；本轮以 worker 端到端为准，差异如实留在文档里而不是抹平。字幕延迟（final 到达时刻减去该段语音结束时刻，1× 实时灌 28.7 s 演讲音频）两次实测 p50 **0.95 / 1.81 s**、max **2.41 s**，其中 0.8 s 是 rule2 强制的判停静音窗口。§46（不是 §33，§33 讲的是 `[mm:ss]` 引用）的"<1 s 目标 / <2 s 最大可接受"只能由 partial 满足，final 天生晚于说完——这句话以前只是推测，现在有数。**⚠️ 这一对数字已于 2026-10-20 被 D-24 推翻为"收尾样本"**：那两次跑只有 4–5 条 final 且都在喂完音频后的尾窗里到达，而公式减去的 `end_time` 本身已含 0.8 s 判停窗口；37 分钟长跑的稳态读数反解出端到端处理只有约 30–95 ms。本节保留原文是为了记录"错在哪"，**任何延迟结论请以 D-24 为准**。
- **两种解码方法在这一份音频上各有输赢，且各自可复现**：`--selftest` 同一条 wav 各跑两遍，greedy 两次逐字一致、beam 两次逐字一致（本机没发现多线程带来的不确定性）。但两者互相不同——greedy 出 2 条 final、首句"昨天是 MONDAY"（对），把中段并成一条长句；beam 出 3 条 final、分段更细，却把首句叠成"昨天**天**是 MONDAY"。所以默认（不传参）保持 greedy，不假装 beam 是全面更好的一侧：**分段粒度与中文叠字在这台机器上是要权衡的，不是升级**。
- **一条测量卫生的教训**：本 Phase 的三次实跑里，第一次用 `--decoding-method modified_beam_search`，后两次（reconnect 脚本重启 worker 时忘了带这个参数）落回 greedy，于是同一份音频出现了"5 条 final vs 4 条"、"昨天天 vs 昨天是"的差别。我一开始把它读成"worker 不可复现"，差点记进 ADR——真因是**参数漂移**。跨实跑比较之前先核对 worker 起参，这条比结论更容易复发。
- **单客户端**：worker 一次只服务一个连接，第二个连接收到 `{"type":"error","code":"busy"}` 后被关。这是"一个后端 ↔ 一个 worker"的 MVP 进程契约，不是产品级的并发限制。
- **Mock Mode 的诚实性**：`MOCK_STT=true` 时 `recording.start{source:"mic"}` 不再悄悄改用脚本播一遍，而是 `module.error{module:"stt", code:"mock_mode_active"}` + `stt.status failed`，消息点名要做的两件事（设 `MOCK_STT=false`、先跑哪条 python 命令）。有单测锁（`sttAdapterContract.test.ts` "refuses the microphone while Mock Mode is on"）。理由：静默替代会让上面每一条实测数字都失去意义。

**D-21 §45 的"STT 自动 reconnect"落在 Adapter，重试预算是有界的**
- 设计文档 §45 只给了六个字（"STT：自动 reconnect"），而 `SttConnectionSchema` 里的 `reconnecting` 状态**此前在生产代码里没有任何生产者**——又一例"schema 先于行为存在"，与本文件 §11/`graph_positions`、D-19 的 `mindmap_edges` 同类，这次是在写重连测试之前先被发现。
- **退避预算** `[0.5, 1, 2, 3, 5, 5, 5, 5]` 秒（8 次，≈24.5 s 窗口），用尽才 `failed`。这个形状是被实测决定的：杀掉 worker 再重启，从"进程消失"到"新 worker 报 ready"实测约 19 s（模型加载占了大头），落在窗口内；而无限拨号会把一次崩溃变成长驻后台工作，Test F 禁止。第一次 `connect()` 的失败**不**进入重连环——那是"启动就没起来"，由 `SessionRuntime` 报 `connect_failed` 并要求用户重新开始一场，语义不同。**⚠️ 2026-10-20 的 D-25 把"19 s"这一格重测了 5 次：同一台机器、同一份起参，warm 状态下停机只有 3.9–4.6 s，五次全部在第 2–4 次尝试内接上。两个数都真，最合理的解释是文件缓存冷热（19 s 那次是当天第一次加载），但这层解释没有被直接验证过。预算因此要按两个数分别读：对 warm 重启有约 5× 余量，对 19 s 冷启动只剩约 5 s——加载时间一旦翻倍这串退避就会见底。**
- **重连必须补两个偏移**，否则是静默的数据丢失（单测 `reconnects a worker that comes back…` 锁住，实测见 `.scratch/live-stt-reconnect.mjs`）：新 worker 是一条全新会话，`seq` 从 1 重新开始、语音钟从 0 重新开始。不补 offset 的话——① segment id 撞上库里已有行，`ON CONFLICT(session_id, id) DO NOTHING` 会把重连后的**全部内容**无声丢掉；② `start_time` 倒退，而转写按 `start_time ASC` 读回，后半截会被插进演讲开头。实测偏移生效：id 从 `live-3` 跳到 `live-4`（跳过的 3 是断线时那条 in-flight partial 的编号），时间戳从 6.2 s 续到 7.8 s，库内 4 行、无重复、单调。
- **断线期间的音频是丢弃，不是排队**：与 D-17 前端重连同一条理由——把几分钟音频重放给一个已经写过这些句子的转写，制造的是重复而不是补齐。缺口就是缺口，`sendAudio` 在未 open 时 `noteDrop()`（一次警告 + 计数，`disconnect` 时汇总成一条 warn）。
- 前端配合：`reconnecting` 期间也要占住那行 notice（原来只有 `failed` 才提示）。字幕停了而麦克风还在收，不吭声就等于让用户对着空气讲十分钟。

**D-22 标点：接受流式无标点，OPEN-1 关闭**
- 实测确认流式 transducer 的输出**没有任何标点**（"…是星期三"结尾无句号），因为它连尾随静音都还没听完就必须在 <1 s 内出 partial。三个选项里选"接受无标点 + 交给下游"：`TranscriptSegment.text` 保持原样（Source of Truth 不做美化），可读性由 MindMap 节点标题与阶段摘要承担——那两处本来就要过 LLM，顺带补标点是零成本的；而引用与检索仍在原文上算，不受影响。
- 被否：加 `OnlinePunctuation`（1.13.8 API 里确实有，但要**再挂一个模型**、在每个 final 后再走一次推理，给字幕加一跳延迟，且标点模型对中英混排的质量未验证）；在 Adapter 里用规则补（会污染唯一权威源）。若将来要真补，正确位置是摘要/导图的 prompt 侧，或者 worker 里 final 之后的一跳——两者都不改动转写原文。这条是 §12 风险 1 的缓解落地。

**D-24 OPEN-6 长跑：真实 STT 路径 37 分钟，泄漏与 id 判定全过，并把 D-20 的延迟数字改错了方向——它测的是收尾，不是稳态**（2026-10-20，编号按时间而非按位置）
- **跑法**：`.scratch/launch-stt-soak.mjs` 起 detached 的四件套（python worker / 后端 / 驱动 / RSS 采样器），`MOCK_STT=false`、`MOCK_LLM=true`、`MOCK_EMBEDDING=true`——**长跑要的是 STT 侧的压力，LLM 与 embedding 换成 Mock 才不会把别人的抖动算进这一格**。音频是双语模型自带 test_wavs 循环 74 遍 = **2225.1 s（37.1 分钟）**，按 1× 定速喂 22251 个 3200 B chunk；worker 起参与 D-20 一致（int8、`--num-threads 4`、`greedy_search`），照坑 4 的规矩钉死在启动脚本里。驱动自带节拍自证：`overruns=0 max=0ms`，所以下面每条延迟数字都不是喂音频的人自己掉拍造成的。
- **完整性（这才是 Test F 在真实路径上要保证的东西）**：`stored=334 = wireFinals=334`、`storedMinusWire=0`、`duplicateStoredIds=0`、`duplicateWireIds=0`、`nullEndTime=0`、`monotone=true`、`textsMatch=true`、`moduleErrors=0`；**partial 3626 条全部只过嘴不落库**——§14「partial 永不入库」第一次在万级样本上被证明，而不是只在 30 秒跑里被顺便观察到。下游计数：mindmap 节点 335、`graph_operations` 335、`summary_blocks` 12、`embeddings` 334、`retrieval.dropped=0`。库文件 1.68 MB + WAL 4.1 MB，无异常膨胀。
- **内存与事件环**：worker RSS 286,656 → 289,232 KB（40.7 分钟 +2.5 MB，≈0.96 KB/s），**没有泄漏曲线**；后端在 81–102 MB 之间来回，首个采样点恰好是启动峰值，所以朴素回归给出的 +3.07 KB/s 是启动形状而不是增长——不拿它当"后端在漏"。497 个 5 秒 `loop_delay` 窗口里 p50 最大 **15.7 ms**、p95 最大 17.3 ms、单点最大 68.2 ms；p50 长期钉在 15.6 ms 是 **Windows 定时器粒度**，不是负载，这条要在报告里说明，否则读者会以为本机常态就有一跳 15 ms 的卡顿。全程 warn/error/drop **各 0 条**，worker 从未掉线。
- **双语模型的首个 partial 延迟（§46 性能目标第一次在这个模型上有数）：n=334，p50 936 ms，p95 1824 ms，max 1974 ms。**按 §46 的两档读：**最大可接受档（<2 s）334 条全数达成，但只剩 26 ms 余量；目标档（<1 s）只有半数达成**（p50 0.936 ⇒ 至少 50% 在 1 s 内；1 s 到 1.824 s 之间那一段的比例本跑给不出，因为脚本只打印了三个百分位、没打印阈值计数——这条采样缺陷记在这里，下次动延迟测量时补）。第一版这里写的是"中位数刚好压线、尾部超预算近一倍"，那是拿 p95 去比 1 s 单档、把 §46 读成了一档。partial 首字延迟由模型出第一个 token 的节奏决定，本机 4 线程 greedy 已是最快档，所以"再优化一下就达标"不成立。取舍因此被改写成：**双语模型在 §46 的字面预算内、但没有余量，且达成是靠中位数不是靠每一条**——"选哪一头属于 §58(d) 的产品权衡，不由我在长跑报告里替用户拍板"（另一头仍未测的是中文准确率，见下）。
- **纠正 D-20 的字幕延迟结论——它把"收尾"读成了"稳态"**。同一条公式（`final 到达时刻 − 开喂时刻 − end_time`）在两次跑里给出 p50 **+0.95/1.81 s**（5d，只有 4–5 条 final 且都在喂完之后的 2.5 s 尾窗里到达）与 **−67 ms**（本次，334 条几乎全部在定速喂的过程中到达）。差别的来源是公式的两个参照系，而不是 worker 行为变了：① 驱动在 wall `i·100ms` 送出的是覆盖到 `(i+1)·100ms` 的那块音频，所以 worker 手上的样本钟**恒领先墙钟约一个 chunk（100 ms）**；② 按 D-20 记录的实现，`end_time` 取的是"端点判定时刻的样本钟"而不是"语音真正结束的位置"，于是它本身就已经含进 rule2 的 0.8 s 判停窗口。稳态下到达时刻 ≈ 样本钟 − 处理耗时，公式因此读出 `−100ms + 处理` = **−67 ms（p50）/ −6 ms（max）**，反解出**稳态端到端处理只有约 30–95 ms**。换句话说：**用户说完一句到字幕定稿的延迟 ≈ rule2 强制的 0.8 s + 约 0.05 s ≈ 0.85 s，而不是 D-20 写的 1–2 s**；那 1–2 s 是"喂完音频之后才到达的收尾 final"，从来不是稳态字幕延迟。**这条改正是对已发布 ADR 数字的推翻，不是因为新数据更多，而是因为看清了指标减掉的那一项正是它要量的那一项。**要彻底钉死仍需要一次干净重测：驱动侧用自己维护的"已喂样本钟"作参照，并让 worker 报端点位置而非当前钟（已登记进 OPEN-6 未完项）。
- **这一跑没覆盖的（不许当成已过）**：① **断线重连的长跑累积行为**——全程零 warn 零 drop，重连环一次都没被触发，它仍只有 30 s 实跑 + 单测的证据；② **浏览器 AudioWorklet 数小时采集**——本次喂的是 wav 循环，不是麦克风；③ **中文准确率**——语料仍是官方 4 段演示音频（中英混排语法课）循环 74 遍，重复内容对 WER 没有意义，所以 R1 的准确率那一半**仍未关闭**；④ 长跑期间没有任何提问，§40 的历史写入不是在负载下被验证的（它由 `qaServer.e2e` 与实跑探针证明）；⑤ `mindmap_edges=0`：这份语料一条 `add_edge` 都没产生，Phase 9 补的边写入路径没有真实 STT 数据的覆盖。**（①④ 已于同日由 D-25 补上；②③⑤ 仍未覆盖。）**

**D-25 重连的长跑累积行为：12 分钟里杀 5 次 worker，偏移复合没有 off-by-one，但把"重连预算其实很紧"这件事测出来了**（2026-10-20，接 D-24 未完项 ①④）
- **跑法**：`.scratch/launch-reconnect-accum.mjs` 起四个 detached 进程（python worker / 后端 / 喂音频的驱动 / 负责杀的 killer）。两条从坑 4 与 D-24 直接学来的工程化：① worker 的起参收进唯一的模块 `.scratch/stt-worker-launch.mjs`，launcher 与 killer 都从它取——**"每个脚本各抄一遍启动命令"正是上次参数漂移的物理原因，把它做成单一 import 点比写成规矩更可靠**；② 杀进程与 `netstat` 轮询绝不放进驱动：驱动是节拍本身，一旦被 `taskkill` 阻塞，掉的就不是 STT 而是喂音频的人。结果 `pacingOverruns=0 maxOverrunMs=0`，节拍自证通过。
- **规模**：720.0 s（12 分钟）1× 定速音频，`MOCK_STT=false`、LLM 与 embedding 仍是 Mock；worker 在 t≈40 s 起被 `taskkill /F` 杀掉 5 次，每次立刻重启，实测停机 **3.9 / 4.6 / 3.9 / 4.5 / 4.6 s**。
- **累积判定全过**：`stored=106 = wireFinals=106`、`duplicateIds=0`、`idMonotone=true`、`seqRegressions=0`、`startMonotone=true`、`startRegressions=0`、`emptyText=0`、`moduleErrors=0`；**partial 1122 条全部没入库**（含跨重连那几条）。最能说明"复合正确"的是一个反直觉的规律：**五轮的 segment id 全部恰好 +2**（5→7、27→29、47→49、70→72、94→96）——`seqOffset += connectionMaxSeq` 把断线时那条 in-flight partial 的号也吃掉了，于是每轮跳 2 而不是 1；跳 1 会撞、跳 3 会漏，**只有 +2 这一种形状能同时满足"不撞且不回退"，而它连续五次都是这个形状**。这比单测更能保证复合没错。
- **重连预算的真实余量被这次跑改写了**：五次全部在第 2–4 次尝试内成功（`maxAttempts=4`，预算 8 次 / 24.5 s），因为 **warm 状态下 worker 从"进程消失"到"重新 LISTENING"只要 3.9–4.6 s**——D-21 当初据以定预算的那个"≈19 s"是**冷启动**（模型权重第一次进 OS 文件缓存）的实测，两者都是真的，但结论要重述：**预算对 warm 重启有约 5× 余量，对 19 s 冷启动只剩约 5 s**。也就是说模型加载时间一旦翻倍（并发负载、机械盘、别的进程正在吃内存），8 次退避就会见底并把一场正在录的会话打成 `failed`。这条不是"理论风险"，是两个实测数相减得到的直接推论；**没跑过的那一格也如实记下：本次全程 warm，冷启动下的重连仍未在长跑里验证过**。
- **重连把两条钟解耦了，而 `[mm:ss]` 引用挂在其中一条上**：全程喂了 720.0 s 音频，转写时间轴只走到 689.6 s——**30.4 s（4.2%）的音频在转写钟上不存在**，且它按每轮约一个停机长度线性累积（每轮 `timelineGap` 2.6–6.7 s）。要说清楚这不是"文本丢了"：断线期间的音频本来就是缺口（D-21 定的"丢弃不排队"），真正的后果是**转写钟与录音墙钟的比在每次重连后不再 1:1**，于是 §33 的 `[mm:ss]` 引用到第 5 次重连之后会比用户直觉的时间晚半分钟，而界面上没有任何地方说这件事。要不要给会话记一个"累计缺口"、或字幕里把断线窗口显式标成空洞，是 §58(d) 的产品决定；本次只把数交出来。
- **顺手补上 D-24 未完项 ④（§40 的历史写入此前从没在负载下验证过）**：这一跑每 100 s 提问一次，共 7 题，`completed=7 refused=0 degraded=0`，库里 `questions=7 / answers=7` 全部可 JOIN，citations 每题 2–3 条、`snapshot_id` 全部有值。**其中 1 题的回答完成时刻正好落在 worker 停摆窗口内**——LLM 路径在 STT 断线期间照常流完并落库，§44 的错误隔离因此第一次在"真实 STT 故障 + 真实历史写入"同时在场的情況下被证明，而不是只在注入 Mock 故障的单测里。
- **仍未覆盖（继续不许当成已过）**：② 浏览器 AudioWorklet 数小时采集（本次仍是 wav 循环）；③ 中文准确率；⑤ 边写入——`mindmap_edges=0`，107 个节点里这份语料一条 `add_edge` 都没产生，Phase 9 补的镜像写入仍只有合成语料与单测的覆盖；⑥ 冷启动下的重连；⑦ 上面那条"转写钟 vs 墙钟"偏差在 UI 上没有任何呈现。

---

### 6.4 部件稳定性加固（全仓库缺陷审计的逐项处置）

**D-27 审计清单上的 11 项：4 项"会静默丢数据"的已修并各配故障注入测试，1 项的审计描述本身被证否，2 项测完之后判定不该修**（2026-10-21，接 D-26 同日更正末尾登记的"拖拽中途被批次弹回"；编号按时间）
- **盘点与排序**：一次性把五个模块 + 前端状态 + 共享 reducer 过一遍，产出 11 项，顺序定为「1→4 属会静默丢数据，优先；5–7 属长会话可感知；8–11 属加固收尾」。这个顺序事后被证明是对的：四项 P0 里每一项都能构造出"用户看不到任何报错，但屏幕上/库里的数据已经不是真的"的场景，而 8–11 里没有一项会改变数据的正确性。
- **本轮唯一新增的纪律来自 D-26 的教训**：每条回归测试都必须**先在撤掉修复的版本上看它变红**，否则它测的是自己的存在。下面每条都附了当时观察到的原始断言信息，没有一条是"写完就绿"却被当成证据的。
- **P0-1 迟到的 LLM 响应写进已经结束的会话**（`backend/src/mindmap/MindMapAgent.ts:38,105,142`）。`stop()` 只停掉计时器与自我触发，**不取消在飞的请求**：回程落地时照样 parse → `applyOps` → `emit`，于是会话状态已经是 `completed` 了还在往图里写节点。修法是 `closed` 闸门在三个位置复查——进入 `runFlush` 时、`await` 模型之后（这一处是关键，parse 之前）、以及 `finally` 里"缓冲够了就再 flush / 重新上弦"之前；catch 体也整段包在 `if (!this.closed)` 里。为什么只有这个模块需要把闸门做到响应落地处：其他自触发模块的数据来源是音频流，`detach()` 之后自然静默，而 MindMap 持有的是**一条跨 `stop()` 的 HTTP 回程**。测试 `discards a response that lands after the session was stopped`（替身模型延迟 60 ms，10 ms 时 stop）撤掉闸门后报 `AssertionError: expected [ { sessionId: 's1', …(4) } ] to have a length of +0 but got 1`；另有 `refuses a forced flush once the session is stopped` 锁住手动 flush 这条路。
- **P0-2 写库失败让内存与磁盘静默分叉**（`backend/src/graph/GraphStore.ts:49` + `backend/src/store/graphRepository.ts:157`）。原实现先把新状态赋给内存、再逐条写库，且 `saveEdges` 是"DELETE 全表 + 逐条 INSERT"裸跑——中途抛错就同时造成两件事：**内存吃下了整批而磁盘没有**，以及**边表被清空只剩写进去的那几行**。修法两处：`applyOps` 改成先算出 `result.state`、在一个事务里落库、成功后才提交内存与总线；`GraphStore` 之外新增可重入的 `transaction(write)`，`insideTx` 为真时直接跑回调。可重入是必需而不是偷懒：`applyOps` 为整批开一个事务，表级镜像（`saveEdges`/`deleteNode`）自己也要求原子性，而 **SQLite 拒绝嵌套 `BEGIN`**。两条测试各测一半：注入 `source: undefined as unknown as string` 触发 NOT NULL → `keeps the previous edge mirror when a save fails half-way`，把 `transaction()` 退化成裸 `write()` 后报 `expected [ { id: 'e2', …} ] to deeply equal [ { id: 'e1', …} ]`（失败那一半真的清空了整张边表）；把 `repo.upsertNode` 打成 `throw new Error("disk full")` → `rolls the whole batch back when a write fails, in memory as well as on disk`，同一退化下报 `expected [ 'r1:0', 'r2:0' ] to deeply equal [ 'r1:0' ]`（即库里有第一批、内存里有两批）。
- **P0-3 embedding worker 的代际与退出静默**（`backend/src/retrieval/OnnxEmbeddingProvider.ts:127,149`）。加载超时后 `launch()` 会另起一个 worker，但旧 worker 的 `ready` 迟到时无人认领——它把**替代品**判成失效，于是这一场剩下的每条向量都走 `embed_failed`。修法是 `generation` 计数：`launch()` 取号并闭包捕获，`handle(reply, generation)` 首行比对，`stop()`/`dispose()` 各自 `+= 1`。同一处还修了第二个更隐蔽的：`spawnWorker` 原先用 `if (code !== 0)` 上报退出，于是 ① 我们主动 `terminate()` 造成的 exit(1) 会去拆掉刚起来的替代 worker，② 正常退出（code 0）**一条都不报**。改成 `terminating` 标志——只压制"我自己终止的"那一种，其余一律 `error`。测试 `ignores a late ready from the worker the load timeout replaced` 撤掉代际闸门后报 `AssertionError: expected [ { id: 1, texts: [ 'b' ] } ] to deeply equal []`。
- **P0-4 拖拽中途来的批次把节点弹回布局位置**——就是 D-26 同日更正登记的那条真缺口，本轮把它从"读代码读出来的"变成"浏览器里量出来的"。测量脚本 `.scratch/drag-batch.mjs`：`?bench=40` 播种 → 对 `bench-5` 按下鼠标 → 移动 6 步 → **在按钮仍未松开时**调 `window.__rccBench.seed(60)` → 读 `getComputedStyle(el).transform`。修法在 `frontend/src/components/MindMapView.tsx:48–73`：`draggingId` 用 ref 记住建住的 id，`setNodes` 时把**该节点的 `position` 从 React Flow 当前值覆盖回来**，其余节点照常跟随新批次；`onNodeDragStop` 清空 ref 并照旧 `pinNode` + 发 `mindmap.node.moved`。两次对照跑在同一个页面、同一个确定性种子上：**有闸门**时 `atRest matrix(1, 0, 0, 1, 0, 330)` → `dragged`/`midDrag`/`dropped` 三条全部 `matrix(1, 0, 0, 1, 143.814, 416.289)`，脚本自报 `PASS`；**短路掉闸门**（退回 `setNodes(flow.nodes)`）报 `FAIL: the mid-drag batch moved the held node 168px (snapped back to the layout)`。0 与 168 之间不需要任何解释口径。注意这条**不是** D-26 那格 200 ms 延迟的一部分：它测的是"位置对不对"，不是"上屏快不快"。
- **P1 三项**：① `TranscriptCore.ts:26` 给 `partials` 加 `partialCapacity = 32` 并按插入序淘汰最老——partial 只服务字幕显示，真实在途个位数，这个上限要的是"坏 provider 一直发新 partial 也不会吃内存"，不是精确窗口；测试灌 40 条后 `p7` 已不在、`p8` 与 `p39` 还在。② `sessionStore.ts:205` 新增 `forgetAsked()`，在 `answer.completed` / `answer.rejected` 上删掉对应题的计时，`recording.started` 整张清空（新会话不该继承上一场的 `askedAt`；这正是 D-17 记过的"服务端重启后前端仍带着上一场状态"那条边界的另一面）。③ **审计里这一项的前半条是错的，我按实测改掉描述而不是按描述去修**：盘点写的是"重连后前端 partials 单调增长"，查生产路径发现 `transcript.snapshot` 在每次（重）连接时把 `partials` 整体置为 `{}`，增长并不存在，真正需要修的只有 `askedAt`。**把"错在哪"登记下来比登记"修了什么"更有用**——否则下一次审计会把它当已确认事实再"修"一遍。
- **P2 四项里有一项是"测完之后决定不修"**：① 停止顺序（`RecordingController.ts:96–110`）改为 `detach → mindmap.flush（仅当 pendingCount>0）→ memory.flushRemaining → retrieval.flushPending → 三个 stop() → setStatus(completed)`。原顺序先排空再断开，而 `detach()` 正是让识别器把手上那段音频跑完的时刻——**它在这段时间里发出的 final 恰好就是刚才那次 flush 漏掉的行**：转写落库了，导图、摘要、索引里没有。安全性有前提且已静态核对：`start()` 每次都 `this.createRuntime(session)` 造全新 runtime（`:44–58`），所以排空的一定是"刚结束这一场"；pause/resume 不碰这些监听器。② `graphEngine.ts:231` 把 `seenOps` 的复制从每 op 一次改成每批一次，并让 `applyOperation` 直接 `return applyOperations(state, [op])`——两个入口合成一份实现，顺带减少"两份逻辑各自漂移"。③ 审计把 `seenOps` 记成 O(n²) 风险，`.scratch/seenops-cost.ts` 在 2000 op／批大小 4 上量出来是**每批一次复制 1088.0 ms，省掉的那部分 18.7 ms，≈2%**；剩下的二次项来自 `detached()` 每批展开 `nodes`/`childOrder`，那是 copy-on-write 纯度契约的代价，不是这次改动能到的地方——所以第 ② 项照做（它免费且统一了入口），但**不许写成性能修复**。④ `seenFinalIds` 我判定**不修**，并在代码里写下为什么不修：给它加帽的直接后果是很老的 id 可以第二次插入，而 `count()` 正是透过它报数的；量级上 37 分钟长跑也才 334 条。**"能加个上限"不是修的理由。**
- **前端两处语义修正**（不算缺陷，算描述失真）：`graphStore.ts:51` 的 `staleOpIds` 改成并集——原实现一批干净的批次会把更早的缺口清零，等于"本地少了一段"这个提醒只在出事那一帧存在，配测试 `keeps reporting an earlier gap after a batch that applies cleanly`；提示文案改成「N 个操作因本地状态对不上被跳过，重连快照会自动补齐」，因为 reducer 把重复 id、成环、端点缺失全归进同一个 `skipped`，旧那句"重放的操作被跳过"是对**服务端重放**的猜测，而这里没有任何证据说是哪一种。
- **Rule 8 闸**：`typecheck` 0 错、`biome lint .` 96 文件全清、`npm test` **205 通过（27 文件，本轮新增 8 条）**、`npm run build` 通过，前端 `index` chunk 30.56 kB（gzip 10.67 kB；上一格 30.08 kB，增量就是拖拽闸门与两处文案）。复现依赖：`.scratch/drag-batch.mjs` 需要 `npm run preview -w @rcc/frontend -- --port 5173 --strictPort`（从仓库根直接 `npx vite preview` 会报 `The directory "dist" does not exist`，因为 Vite 的 cwd 必须是 packages/frontend）；`.scratch/seenops-cost.ts` 用 `npx tsx` 跑。
- **不许因为"11 项都处置过了"就当作关掉**：① 4 项 P0 的故障注入是**单测级**的（NOT NULL、抛错、替身 worker），没有真·磁盘满或真·进程被杀下的端到端验证；② 停止顺序的改动没配 e2e，它靠的是对 `start()` 每次新建 runtime 的静态核对加上"排空在断开之后"这个顺序本身；③ 2% 那一格是 Node 里的 reducer 计时，不代表浏览器（那边每批 op 数是个位数，但也没测）；④ 中途拖住的节点**在基准路径下落不进 `graph_positions`**（D-26 已说明基准是纯客户端、没有 session 可写），所以这条修复的持久化一半只有单测与真实会话路径的保证；⑤ §58(d) 那批产品决定（默认折叠、问答历史读取侧、`[mm:ss]` 钟漂移的呈现）本轮一项都没碰。

**D-28 第二轮盘点的 6 项：布局与落库两项 P0 在浏览器/单测里各自量到红，两项"单飞链被空 Promise 顶掉"是同一个缺陷的第二、第三次出现，前端麦克风一半靠实跑验收**（2026-10-21，接 D-27；编号按时间）
- **本轮开工前立的规矩只有一条**：D-27 那条"先撤掉修复看它红"继续生效，且**红信息必须是当场重跑出来的**，不是引用上一段会话里的记忆。为此 #49/#50 在写这条 ADR 之前又各跑了一次红绿对照（下面的数字就是重跑得到的）。
- **#49 P0 布局：顶层树互相压盖 + 行高常量与实测盒高不符**（`frontend/src/state/layout.ts:9–19,43–57`）。两个独立的错：① `NODE_H` 写的是 40，而 `.mind-node` 实际画出来是 72（单行标题）／87（两行），邻居行**按构造就会重叠**；② 每棵顶层树的锚点用"上一棵的底"往下 66 px 摆放，而 tidy layout 的兄弟是围绕父节点居中的——一棵树会向上顶出它的根，所以拿根当底就压盖。修法：`NODE_H = 88` 并在注释里钉住"这个数就是 CSS 里那条规则的高度"；锚点改成先扫一遍本树的 `minOffset/maxOffset`，把根放在 `nextTop - minOffset`，`nextTop` 再按 `anchor.y + maxOffset + NODE_H` 推进。红绿对照（`.scratch/layout-overlap.mjs`，`?bench=240` 真出画的盒子上两两求交）：**只把 `NODE_H` 改回 40** 时 `{"nodes":240,"overlappingPairs":78,"worstOverlapPx":366}` 并自报 `FAIL: 78 overlapping node pairs (worst 366 px²)`；改回 88 后 `{"overlappingPairs":0,"worstOverlapPx":0}`、`PASS`。单测 `layout.test.ts:50,64,72` 三条锁住"每棵顶层树都在前一棵下方""间隙随上棵树高度变化""被拖动的根照样赢"。**为什么必须有一个浏览器级检查**：这三条单测在修复前也是绿的——它们断言的是相对次序，而压盖恰恰发生在"次序对但高度错"的时候。
- **#50 P0 后端：一条转写落库失败会击穿整个进程**（`backend/src/transcript/TranscriptCore.ts:52–69`）。`acceptFinal` 原先裸调 `store.appendFinal()`，而它的调用栈是 STT provider 的 socket 回调——**那里没有人 catch**，一次 SQLite `IOERR` 就是 uncaught exception，整场录音随它去。修法：把持久化写成功当作后面一切的前提，失败时 `log.warn` + `bus.emit("module.error", { module: "transcript", code: "append_failed", recoverable: true })` 后直接 `return`——**且不烧掉这个 id**：一句从没落库的话必须还能被随后的重投递收下，否则失败反而造成永久的漏行。红信息：撤掉 try/catch 后 `keeps a store failure inside the transcript module instead of throwing at the caller` 报 `AssertionError: expected [Function] to not throw an error but 'Error: disk I/O error' was thrown`；装回后该文件 9 条全绿。
- **#51 P1 导图：`flush()` 在请求在途时是个 no-op，尾批静默丢图**（`backend/src/mindmap/MindMapAgent.ts`）。原 `flush()` 直接 `await this.runFlush("manual")`，而 `runFlush` 一发现 `inFlight` 就报 `mindmap.skipped` 返回——**说话的人刚讲的最后几句正在那次在途请求的缓冲之外**，`recording.stop()` 于是把转写存了、导图没等。修法是有界排空：`flush()` 循环 `await this.busy` → 缓冲非空则再 `runFlush("manual")`，上限 `MAX_DRAIN_ROUNDS = 32`，末尾再 `await this.busy` 一次（一次响应可以自己再触发一批，会话不能在它底下被关掉）；`busy` 只由 `beginFlush()` 写，而 `beginFlush` 先算 `takesOver = !this.inFlight && this.buffer.length > 0`（**必须在调用 `runFlush` 之前算**，它会同步把 `inFlight` 置真）——只有真的启动了请求才许接管这个字段。**第一版就是栽在这里**：无条件 `this.busy = chain` 让被跳过的那次把已 resolve 的空 Promise 顶了上去，排空循环误判"链已结束"，尾巴照旧丢。同时 `RecordingController.ts:102–107` 去掉 `pendingCount > 0` 前置：识别器毫秒级关闭、模型秒级回程，加守卫等于专门放弃最常见那种情况。测试两条：`drains the tail that landed during an in-flight request when asked to flush`（单元）与 e2e `waits for the map request that is still in flight when the recording stops`（每个 mindmap 请求固定 `await wait(120)`，因此红与绿不由时序巧合决定）；撤修复后 e2e 报"8 条 final 里只有 7 条被请求过／库里 2 个节点 vs 8"。顺带 `mindmap.forceUpdate` 现在也走排空。
- **#52 P1 摘要：与 #51 同一个缺陷，外加"先释放子块再写父块"**（`backend/src/memory/MemoryCore.ts`）。① `trigger()` 无条件 `this.running = this.flushWindow()`，而 `flushWindow` 在模型忙或窗口空时返回一个已 resolve 的 no-op——`flushRemaining()` 于是以为链走完了，尾窗被 `stop()` 清空时它那篇摘要还没写进库，正好落在会话 dispose 之后。修成 `takesOver = !this.inFlight && this.window.length > 0 && !this.closed`，与 `MindMapAgent.beginFlush` 同一个形状。**同一次审计里第三处见到它**（前两处是 #51 与本条），所以把它当成一个模式记：凡是"单飞 + 排空"的结构，都必须在启动前判断这次调用会不会变成空转。② `runMerges` 原先 `this.pending[level] = queue.slice(mergeFactor)` 在 `commit(merged)` 之前，父行写失败时子块已被释放——**整组子块对后续所有合并永久隐身**。改成先 `commit` 再释放，注释写明"是那次写库让子块算被吸收"。测试靠替身撑住：`FlakySummaryRepository` 在指定层级抛一次 `SQLITE_IOERR: disk write failed` → `keeps children pending when a merged block cannot be written`；`SummaryStub` 的 stage 请求改为无限 park（`holdStages`，不是固定延时——先前用 `delayMs: 40` 时 checkpoint 实测 `busy=false pending=0`，说明红的前提根本不稳）→ `waits for the summary that is still in flight when the recording ends` 断言 `blockCount === 2`、`pendingCount === 0`、覆盖 2 个不重复 segment id。memoryCore 12 条、重跑 5 次全绿。
- **#53 P1 共享：`merge_node` 缺祖先校验，成环后整枝从画面上静默消失**（`shared/src/graph.ts` 闸门 + `shared/src/graphEngine.ts` reducer）。合并会把 source 的孩子挂到 target 底下，于是"把祖先并进它自己的后代"会让那一段变成自己的子孙——布局只从根往下走，**这一枝连同里面所有内容一起不再出现，而没有任何报错**。修法两层都拦：闸门返回 `reason: "cycle"`，reducer `skipped.push(op.opId)`。**为什么两层都要**：快照重放与其他客户端落地走的是 reducer，它们根本不经过闸门；方向是 `isDescendantOrSelf(next, op.targetNodeId, op.sourceNodeId)`（target 是不是 source 的后代），写反了就成了误杀正常合并。测试 `refuses a merge whose target is a descendant of the source`（断言 `rejected[0].reason === "cycle"`）与 `refuses a merge that would bury a branch under its own descendant`（a→b→c，merge a into c 之后 `toNodeList` 仍是 [a,b,c]、`childOrder.c` 为空）。
- **#54 P1 前端麦克风：半路失败即泄漏设备；断线时按钮禁用让人无法释放**（`frontend/src/audio/microphone.ts`、`frontend/src/components/RecordingControls.tsx`）。① `startMicrophone()` 里 `getUserMedia` 成功之后的每一步（`addModule`、`resume`、装配 worklet）都可能抛，而抛之前设备已经拿到——**麦克风指示灯一直亮着，别的程序用不了，用户没有任何办法**。修法：成功拿到 stream 之后全部包进 try，`release()` 统一 `track.stop()` + `context.close()`（已 closed 时不重复关），catch 里先 `release()` 再原样抛。新增 `frontend/test/microphone.test.ts`（stub 掉 `navigator`／`AudioContext`／`AudioWorkletNode`，注入三处失败各测一次）：修复前 3 红 1 绿，红信息含 `AssertionError: expected false to be true`（track 还 live）与 `AssertionError: promise resolved "{ stop: [Function stop] }" instead of rejecting`（失败被吞掉）；修复后 4 条全绿。② 暂停／结束原先带 `offline ||`，而**释放设备是纯本地动作**：`sendCommand` 在 socket 非 OPEN 时自己丢弃（`net/connection.ts:44–48`），`link` 变化也不动 `recording`，所以状态闸门单独就够。去掉这两个 `offline`，继续／两个开始／立即整理导图保持守卫（它们需要服务端配合）。**这条只做单测不算数**，因为改的是渲染出来的 `disabled`：`.scratch/mic-release-offline.mjs` 用 headless Edge + `--use-fake-device-for-media-stream` 真按下鼠标事件走一遍，断线由**把页面自己的 WebSocket 端口改写到一个没人听的端口**注入（close 来自浏览器网络栈而不是替身）。实测序列：录音中 `tracks=[["live"]] contexts=["running"]` → 断线后 `{"暂停":false,"继续":true,"结束":false,"立即整理导图":true}`（**该能点的能点，该禁的照禁**）→ 按结束 `tracks=[["ended"]] contexts=["closed"]` → 重连快照回来后再按一次，`录音` 变 `idle`、后端 `health.state = "idle"`。控制组：把 `offline ||` 加回去重建前端，同一个脚本报 `FAIL — 「暂停」在断线时仍被禁用；「结束」在断线时仍被禁用，麦克风仍未释放：tracks=[["live"]] contexts=["running"]`。绿灯跑过 2 次。③ 这条改动本身造出一个新的假信号（本地已经停止采集、徽标还写着 recording），所以加了一条 `detached` 提示：`sendCommand` 返回 false 时置位，服务端状态不再是 recording 或用户重新开始时清零；脚本断言它在断线时、重连后都还在，会话结束后消失（此时回到既有的"识别引擎未连接"）。**这次实跑的边界必须写清**：后端以 `MOCK_STT=true` 启动，麦克风录音被识别层拒绝（`mock_mode_active`），所以全程 0 条字幕、0 个节点——它测的是"设备释放与按钮可达"，**不是**转写内容。
- **Rule 8 闸**：`typecheck` 0 错、`biome lint .` 98 文件全清、`npm test` **219 通过（29 文件）**、`npm run build` 通过，前端 `index` chunk 30.91 kB（gzip 10.87 kB；D-27 那格是 30.56 kB／10.67 kB，+0.35 kB 里装的是麦克风释放、按钮闸门与两条提示文案）。对账：与 D-27 那格（205 通过／27 文件）相比是 **+14 条测试、+2 个文件**，其中确定新建的是 `frontend/test/microphone.test.ts`；本轮没有逐条统计"哪几条属于哪一项"，只核对总量。实跑为 `.scratch/mic-release-offline.mjs`（需先起 `vite preview` 与 `PORT=8787` 后端）与 `.scratch/layout-overlap.mjs`（`?bench=240`）。本轮没有新增三方依赖，`THIRD_PARTY.md` 不动。
- **剩下的两格没关掉，别把"六个任务完成"读成"审计做完"**：#55（字幕无条件吸底、`graphStore.snapshotOperations` 静默丢子树而不写 `staleOpIds`、STT 重连后 `partials` 无上限）与 #56（`childOrder` 未持久化、repair 与 SDK `maxRetries` 叠乘、`QaCore` 的 closed 闸门覆盖、标题长度无上限）仍开着；#54 的实跑只覆盖断线释放这一条路径；#50 的注入是替身抛错，不是真·磁盘满；#51/#52 的排空上限（32 轮）是给"边说边按立即整理导图"兜底的，没有人量过真会跑满它需要多久。
  *（D-28 写下这格之后不久，#55 已由 D-29 关闭，#56 已由 D-30 逐项处置完——顺带那一次实跑抓出的缺口登记为 §13 OPEN-7"重启后旧会话的图读不回画面"，本轮没有实现。上面那句"实跑只覆盖到的路径"仍然成立：D-30 换的是"提问进行中按停止"这条路径，#54 的断线释放依旧没重跑过。）*

**D-29 #55 三项前端 P2：一条测量台自己错两次才量对"吸底"，一条测试写了却锁不住任何东西，一条把审计结论读窄了会修错方向**（2026-10-21，接 D-28；编号按时间）
- **#55a 字幕无条件吸底，把往上翻的读者每来一行就拽回底部**（`frontend/src/components/SubtitlePanel.tsx:14–25,30–37`）。原实现是 `useEffect(..., [finals.length, live]) → el.scrollTop = el.scrollHeight`，无条件执行——**在实时转写里读一句已经写下来的话，唯一的办法是停止录音**。修法：加 `atBottom` ref，由 `onScroll` 维护（`scrollHeight - scrollTop - clientHeight < 24` 才算"在底部"），effect 只在 `atBottom.current` 为真时滚动。24 px 是拍的容差，没有实测依据，写在这里以免被读成校准过的数。
- **为什么这条非浏览器不可，以及测量台怎么把自己骗了两轮**：`scrollTop` 只有在挨着 `scrollHeight` 时才有意义，node 环境里没有任何东西能看见那次"拽回"。`.scratch/subtitle-follow.mjs`（headless Edge 155 + 自写 CDP，脚本自己 spawn `PORT=8787` 后端，需先在 5173 起 `vite preview`）第一次跑报 `the panel never became scrollable`（`lines=8 scrollHeight=232 clientHeight=232`）——**前提不成立，不是代码错**：`MOCK_STT_REPEAT` 默认为 1，一趟脚本只产 8 条 final，面板比内容还高。改开 `MOCK_STT_SPEED=8 MOCK_STT_REPEAT=0`（`MockSTTProvider.ts:85` 逐趟续排，id 用 `pass * 8 + index` 编号，所以续趟真的会新增行而不是被 `TranscriptCore` 按 id 去重吃掉）之后第二次跑报 `阅读者被拽回底部：新增 2 行后 scrollTop 0 → 46`——**又是测量台的错**：28 行时只溢出 2 px，24 px 容差下"顶部"本来就"在底部"之内。于是 step 1 改成要求滚动余量 >150 px，step 2 加一条 `room ≥ 100` 的前提断言。**这两次红都没有指向产品代码，但必须记下来**：一个"红"如果能被前提不成立解释，它就还没资格当证据。
- **最终红绿对照（同一脚本、同一构建路径）**：绿（跑过 2 次，数字一致）`step 1 lines=28 scrollHeight=772 clientHeight=611 gap=0` → `step 2 baseline scrollTop=0 room=161 px` → `step 2 scrolled up: lines 28 → 31, scrollTop=0 → 0` → `step 3 back at the bottom: lines 31 → 34, gap=0`，`RESULT: PASS`。控制组只把 `if (el && atBottom.current)` 改回 `if (el)` 并重建前端：**同样的 28 → 31 行**，`scrollTop=0 → 232`，`RESULT: FAIL — 阅读者被拽回底部`。新增行数一样、只有 `scrollTop` 不同，这才是那条 effect 的对照。
- **#55b 快照会静默丢掉一整枝**（`frontend/src/state/graphStore.ts:99–124`）。`snapshotOperations` 原来在"没有任何待放置节点能挂上已放置父节点"时 `break`——父节点已不在快照里的孤枝、以及合并闸门上线前写进库的环，都**连子带孙一起消失，且没有报警**：`hydrate()` 把 `staleOpIds` 覆盖成 `result.skipped`，而那里恰恰是空的。更要命的是提示语写着"重连快照会自动补齐"，而**这次丢掉内容的就是那份快照**。修法两层：① 挂不上的节点照样 emit 进 reducer（它按 `exists`/`isDescendantOrSelf` 拒绝，opId 自然落进 `skipped`），② 新增 `snapshotStale` 标志区分"实时帧造成的缺口"（重连真能补）与"快照造成的缺口"（重连就是那次失败），`MindMapView.tsx` 据此换文案。**这个标志是粘性的**：之后新出现的实时缺口不会把它翻回 false，宁可少承诺也不误承诺——该形状没测过。
- **本项的真正教训在控制组里**：第一次做对照（把 `snapshotOperations` 改回 `if (index === -1) break`）跑出 `Tests 2 failed | 9 passed` 之前，我先看到的结果是**第二条新测试在桩代码下照样绿**——它只断言 `snapshotStale` 为 `false`，而"恒 false"的桩当然满足。补上"快照确实造成缺口时必须为 `true`"这一断言之后，控制组才给出两条红：`AssertionError: expected [] to deeply equal [ 'snapshot:x', 'snapshot:x1' ]` 与 `AssertionError: expected false to be true`。**"写了回归测试"和"测试锁住了行为"是两件事**，只有撤掉修复会红的那条才是后者。装回修复后 `graphState.test.ts` 11 条全绿。
- **#55c 断线后字幕上留着一句"还在听"的半句**（`frontend/src/state/sessionStore.ts:113–123`）。`stt.status` 进入 `reconnecting`/`failed` 时原先只更新状态徽标，`partials` 原样留着。而识别 worker 每次连接都把自己的 segment 序号重新起算（`SherpaSTTProvider.ts` 的 `seqOffset`/`clockOffsetSec` 那套再基），**那条 partial 永远等不到配对的 final**，于是它作为"活行"一直挂在字幕底部——几分钟前就停了的语音，画面上还在被听见。修法：`gone = state === "reconnecting" || state === "failed"` 时把 `partials` 置空。控制组：去掉 `gone ? {} :` 后 `1 failed | 6 passed`，红信息 `AssertionError: expected { 's1-live-3': '世界模型可' } to deeply equal {}`；装回后 7 条全绿。
- **这一项容易读成"给 partials 加上限"，而那正是错的方向**，所以点名对照 D-27 那条审计更正：`partials` 的内存上界**从来不是**这次的问题（`transcript.snapshot` 每次（重）连接都整体置空，D-27 已据此判定"单调增长不存在"）。这次修的是显示层的一条僵尸行。因此**没有加容量帽**，与 D-27 的"能加个上限不是修的理由"一致；现在 `partials` 只由三条路径收缩——final 到达时删该 id、快照整体置空、断线时置空。
- **Rule 8 闸**：`typecheck` 0 错、`biome lint .` **Checked 98 files，无诊断**、`npm test` **223 通过（29 文件）**、`npm run build` 通过，前端 `index` chunk **31.35 kB（gzip 11.05 kB）**。对账：与 D-28 那格（219 通过／29 文件、30.91 kB／gzip 10.87 kB）相比 **+4 条测试、文件数不变**（四条分别加进已有的 `graphState.test.ts` 与 `sessionStore.test.ts`，各 2 条），+0.44 kB 装的是 `atBottom` 闸门、`snapshotStale` 与两条文案分支。本轮没有新增三方依赖，`THIRD_PARTY.md` 不动。**注意别把"+4"读成逐条归属**：只核对总量，与 D-28 同一口径。
- **没覆盖到的面，别读成已覆盖**：① #55c 只有单测——"真 worker 断线时屏幕上确实挂着半句"这个形状，本轮没有在浏览器里复现过（要接真 STT 并把 Python worker 打掉，属 D-25/#5d 那套测量台，没做）；② #55b 的文案分支只在 store 层证明，`MindMapView` 那两句中文没有渲染级断言；③ `snapshotStale` 的粘性（快照缺口之后又出现实时缺口时该说哪句）是判断，不是实测；④ 24 px 容差与 `room ≥ 100` 两个阈值都是为脚本定的，不是为用户的手感定的；⑤ ~~#56（`childOrder` 未持久化、repair × SDK `maxRetries` 叠乘、`QaCore` closed 闸门覆盖、标题长度无上限）仍开着~~ —— 已由下一条 D-30 逐项处置：前三项修掉并各配控制组，第四项用实测判成不修、只把代价钉在测试与注释里。

**D-30 #56 四项收尾：一项用实测判成"不修"，一项把 6 次请求压成 2 次，一项的判定权在前端那句文案手里，而实跑顺手抓到一条比这四项都大的缺口**（2026-10-21，接 D-29；编号按时间）
- **#56 第一项：标题与摘要给出上限，用截断而不是拒绝**（`packages/shared/src/graph.ts:148–153`，`MAX_TITLE_CHARS = 40` / `MAX_SUMMARY_CHARS = 160`，`add_node` 与 `update_node` 的 patch 两条门都过 `clampText`）。审计说的"没有上限"是真的：prompt 要求"标题不超过 14 个字"（`prompts/mindmap.ts:14`）却没有任何一处执行它。为什么风险不在布局而在成本：`.mind-node` 早就被 CSS 夹成两行标题 + 一行摘要（`styles.css:322–372`，`NODE_H = 88` 与它同源），**超长字符读者根本看不见，但模型看得见**——`capNodes` 是 `nodes.slice(-40)`（`mindmap/MindMapAgent.ts:241–243`），`mindmapUserPrompt` 把每个节点的 `title` 与 `摘要=` 原样回喂进每一次 flush prompt，`qaUserPrompt` 同理。所以这两个数买的是"回喂有界"，不是"画面不撑破"。**选截断不选拒绝**：拒绝会连带丢掉整批概念，而截断只丢字符。40/160 是"屏上可见之内的宽松上限"，不是校准值。控制组：把 `clampText` 改成原样返回 → `packages/shared/test/graph.test.ts:21` 红在 `expect(added.node.title).toHaveLength(40)`（实得 230 字），装回后 shared 15 条全绿。
- **#56 第二项：repair 预算与 SDK 传输重试不许相乘**（`packages/backend/src/llm/OpenAICompatProvider.ts:78–115`）。三处改动合成一条不变量：**整个 `structuredGenerate` 最多 `MAX_REPAIR_ATTEMPTS + 1 = 2` 次请求**。① 每次 `create(…, { maxRetries: 0 })` 关掉 SDK 内部重试；② 传输失败消耗的是同一个预算里的**一次尝试**（`catch` 里记下错误、`nextUser = user` 原样重问，不追加校验错误——模型没答过，就没有可修的东西）；③ 循环若结束在传输失败上，抛**原始错误**而不是 `LLMStructuredOutputError`（否则日志会指控"模型输出不合法"，而真相是端点没回话）。叠乘的代价测出来是硬的：把 `maxRetries` 恢复成 SDK 默认 2，本地 stub 数出 **6 次请求**（`(1+1) × (2+1)`，`llmAdapterContract.test.ts:95`），每一次都可能跑满 `LLM_TIMEOUT_MS = 30 s`，而这段时间 `MindMapAgent` 的单飞锁不放——§56 禁的"AI 请求堆积"就是这个形状。**顺带把两条没牙的断言补上牙**：这条测试原来只断言 `failure instanceof Error`，而控制组"把传输错误吞成 schema 错误"在它下面**照样绿**（`LLMStructuredOutputError` 本身就是 `Error`）；加进 `not.toBeInstanceOf(LLMStructuredOutputError)` 与"第二次请求仍是原始 user 提示"之后，两次单独的控制组各自红一次（去掉 `if (transportFailure !== null) throw` → 前者红；把 catch 里的 `nextUser = user` 换成 `repairPrompt(user, lastError)` → 后者红）。这是 D-29"写了测试 ≠ 测试锁住行为"的第二次现场。
- **#56 第三项：`QaCore` 的 closed 闸门补齐三处**（`packages/backend/src/qa/QaCore.ts:83`、`:177`、`:199`；`:151` 那处早已存在）。检索是 QA 第一个 `await`，所以会话中止最容易落在那里：越过它就会发 `answer.started`——一句"接下来有字"的承诺，背后已经没有会话和客户端——然后真的花掉一次模型调用；早退分支必须自己 `inFlight -= 1`，否则并发计数漏减，下一场会话每题都被判 `busy`。另外两处把 `module.error` 与降级 `answer.completed` 关在闸门后：**被取消的录音不是一次模块故障**，把它广播出去，下一个客户端会在调试面板里看到一场它没参加过的失败。`record("answer", …)` **不受闸门影响**（行是"答过什么"的持久证据，不是发给已离开的人的消息）。四个控制组各撤一处、各红一次：撤早退 → `answer.started` 发出且 `llm.streams === 1`；撤 `module.error` 闸门 → `errors` 收到一条 `answer_failed`；撤降级完成闸门 → `completed` 多一条；把落库也包进 `if (!this.closed)` → 行直接消失。**这一项最险的地方是我第一版测试根本走不到失败路径**：脚本写成 `failAfter: 1, delayMs: 20` 时，`close()` 落在 5 ms，首个 chunk 在 20 ms 到达并被 `for await` 自己的 `if (this.closed) break` 吃掉，`catch` 一次都没进——三条断言里两条空洞通过。改成 `failAfter: 0`（首个 chunk 即抛）才是真正的失败路径，`qaCore.test.ts` 现在 21 条全绿。落库断言顺手改成 `expect(row?.degraded).toBe(1)`（可选链），这样第四个控制组的红是"expected undefined to be 1"而不是一句 `TypeError: Cannot read properties of undefined`。
- **顺着第三项抓出来的语义问题，判定是"不改代码"，因为判定权在前端那句文案手里**：会话中途结束时流被打断，代码走的是**成功路径**，于是历史里留下一行 `degraded = 0`、文本只有半句。要不要改成 1？`packages/frontend/src/format.ts:19–33` 已经把"结束时什么都没有"分成三种说法：闸门拒绝 / `degraded`（"模型没能给出这一题的回答，请重试。"）/ 已完成但空（"连接中断时这一题的回答没能送达，请重新提问。"）。**把取消标成 `degraded` 会对用户撒一个关于模型的谎**，而 `faultIsolation.e2e.test.ts:111` 那句"`degraded` is reserved for the model"就是这个意思（它的语境是"索引坏了不该算模型失败"，不是"取消该算什么"——我原先以为这两处会打架，读宽了）。所以判定是：**加特征化测试钉住现读**（`qaCore.test.ts:311`），而不是改语义。它同样过控制组：把成功路径的 `record` 包进 `if (!this.closed)` → `row?.text` 红；把 `degraded: false` 改成 `degraded: this.closed` → `row?.degraded` 红。写这条测试时还纠正了我自己一个时序误会：先按"立刻关闭"来写，结果首个 chunk 都没落地、行里是空串——**截断发生在 chunk 之后，不是在 chunk 到达的那一刻**，于是改成等 30 ms 才真拿到"前半句"。
- **#56 第四项：`childOrder` 持久化判成不修，理由是实测而不是印象**：`.scratch/op-types.ts` 用 `node:sqlite` 只读遍历 `.scratch/*.sqlite` 统计 `graph_operations` 的 `type`，本轮 **665 行里 `add_node` 占 665（100.0%）**，`move_node`／`merge_node`／`delete_node`／`add_edge` 一条都没有。再看代码侧：拖动节点发的是 `mindmap.node.moved` → `savePosition`（`MindMapView.tsx:72–79`），**不发 `move_node`**。所以"兄弟顺序"这个状态，产品今天不会产生它。`GraphStore.hydrate()`（`:32`）用 `loadNodes` 的 `created_at` 顺序重建 `childOrder`（`graphRepository.ts:12–13`），行里既没有序号也没有别的读法——为从未发生的操作加一列，代价是 schema 变更与整条写入路径。判定写进两处：`hydrate()` 的注释，以及 `graphStore.test.ts:144` 那条把代价说出来的测试（内存里 `[c, b]`，重开后 `[b, c]`）。
- **真实运行抓到一条比这四项都大的事，登记为 OPEN-7**（`.scratch/qa-stop-restart.mjs`，自己 spawn 后端两次、读同一份 `.scratch/rcc-qa-stop.sqlite`）。① 行为面：`question.ask` 与 `recording.stop` **同一 tick 发出**，答案照常流完（`answer.started 1 / answer.token 103 / answer.completed 1`，`module.error 0`，停止后 `/api/debug` 仍应答）。原因在排空顺序：`RecordingController.stop()` 第一件事是 `this.runtime = null`（`:143`），而 `runtime.dispose()`——也就是 `qa.close()`——排在整条链的**最后**（`:150–169`：detach → `mindmap.flush()` → `memory.flushRemaining()` → `retrieval.flushPending()` → 三个 `stop()` → 发 `recording.stopped` → dispose）。所以生产里 closed 闸门守的是"排空结束之后迟到的一切"，**不是"按下停止的那一秒"**；本轮单测的时序与真实时序不同，这条差异必须留字，免得把单测绿读成"停止即刻打断答案"。② 持久面：停止后盘上是 1 个 `completed` 会话、5 条转写、5 个节点、`questions` 1 行 + `answers` 1 行（103 字、`degraded = 0`）。③ 然后**重启后端读同一份库**：`/api/session` 空闲时 `sessionId: null, nodes: 0`；再开一场录音拿到的是**新 session、0 个节点**。那 5 个节点在盘上，却没有任何生产路径能读回画面——`hydrate()` 唯一的生产调用点是 `SessionRuntime` 构造（`:103`），而 `RecordingController.start()` 永远 `randomUUID()` 新会话（`:86`）。**"重启不丢图"此前是愿望不是事实**：我把 `hydrate()` 那行原文（"Rebuild from disk so a restart does not lose the tree"）改成了带实测的说明，缺的那条路径登记进 §13 OPEN-7，不在本轮实现（它需要会话选择/恢复的产品决定，不是一段补丁）。④ 顺带一个非缺陷读数：停止前 `/api/session` 是 0 节点而盘上 5 个，是 `MINDMAP_MIN_SEGMENTS = 6`（`env.ts:156`）与停止排空的组合——mock 语速 8 下 6 秒只有 5 条 final，图本来就还没到触发线。
- **Rule 8 闸**：`typecheck` 0 错、`biome lint .` **Checked 98 files，无诊断**、`npm test` **229 通过（29 文件）**、`npm run build` 通过，前端 `index` chunk **31.35 kB（gzip 11.05 kB）**——与 D-29 一字不差，因为本轮改动全在 backend / shared / 测试里，前端产物一行没动。对账：223 → 229，**+6 条**（`qaCore.test.ts` +3、`graphStore.test.ts` +1、shared `graph.test.ts` +1、`llmAdapterContract.test.ts` +1），文件数仍 29。无新增三方依赖，`THIRD_PARTY.md` 不动。按坑 3 手动 tsc 四个被改的测试文件：新写的代码 0 错，本轮把 `graphStore.test.ts:39/120` 那两处 `bus.on(..., (n) => push(n.id))` 的块体写法补齐（与 `qaCore.test.ts` 等同款既有约定），剩下的 9 行全在我没碰的 `llmStubServer.ts`（`noUncheckedIndexedAccess` 下 `reply` 可能为 undefined，只有这条手动命令才会看见）。
- **没覆盖到的面，别读成已覆盖**：① 没有真 LLM key（OPEN-3），所以"6 次变 2 次"和"230 字标题"都是 stub / 机制级证据，**模型实际多常写出超长标题没有任何频率数据**；*（这一格当天晚些时候被下一条 D-31 关掉一半：key 到手、真模型跑通，超长标题那一半量到的是"8 个节点、最长 11 字、`over14=0`"——一次跑、8 个样本，够证明"会发生"，不够当频率数据。）*；② op 日志只记通过闸门写入的 op，`parseGraphOperations` 拒绝掉的候选不进这张表，所以"从未有过 `move_node`"严格说是"从未有过一条**被写入的** `move_node`"，被拒绝的多少条看不见；③ OPEN-7 只是登记，`hydrate()` 的跨会话恢复没有实现，也没有测试覆盖"重启后能看到旧会话的图"；④ 第三项的三处闸门没有浏览器级验证（只有单测与一次 mock 实跑）；⑤ `MAX_TITLE_CHARS = 40` 与 `MAX_SUMMARY_CHARS = 160` 是推导值，没有做过"截断后读者是否还能认出这个概念"的实测；⑥ 特征化测试钉住的是**现读**（取消不算模型失败），它不等于"这个语义是最优产品决定"，真要改语义时必须先改 `format.ts` 那三句文案的分工。

### 6.5 真实 LLM provider 落地决策（Phase 10）

**D-31 第一次把真 key 接上去，第一轮就把导图 100% 拒了：三处修复、一条被证否的选型依据、以及"单测全绿而生产全红"的成因**（2026-10-21，接 D-30；编号按时间）
- **跑法与判据**：`.scratch/live-real-llm.mjs` 自己 spawn 后端（`--import tsx`，`MOCK_STT=true MOCK_STT_SPEED=4 MOCK_LLM=false MOCK_EMBEDDING=true`、`DB_PATH=.scratch/rcc-real-llm.sqlite`），同一进程内问两题，按 PID `SIGTERM` 收尾，再以读写方式打开 WAL 库核对。**判据里有一条专门防自欺**：日志首行必须出现 `"llm":"openai-compatible"`，否则"真实 provider 通过"这句话根本不知道自己在断言什么（第一版判据写的是排除 `"llm":"mock"`，且把日志截到 220 字符——两处都会让一个 Mock 跑被读成真跑）。表名是 `mindmap_nodes`，不是 `mind_map_nodes`。
- **`.env` 的加载语义要先钉住**：`config/env.ts` 是全仓库唯一读 `process.env` 的地方，`loadConfig(cwd)` 会 `process.loadEnvFile(resolve(cwd, ".env"))`，而 `str/int/bool/float` 把 `undefined` 与 `""` 一律当"未设置"——所以 `LLM_MODEL=` 不是空模型名，是回落到默认值。更关键的一条实测：**已经是进程环境变量的项不会被 `.env` 覆盖**（`MOCK_LLM=true node -e "process.loadEnvFile('.env')"` 仍是 `true`）。临时改用任何环境变量都比改文件可靠，key 只写进仓库根的 `.env`，不进 `docs/`。
- **第一条实测就把 §7 的选型依据推翻了**：本文件 §7「模型选择」原先写着 DashScope「**支持真 strict `json_schema`**」，那是 Phase 0 的二手印象。实测这个专属实例上 `response_format={type:"json_schema", strict:true}` 直接回 `This response_format type is unavailable now`；能用的是 `json_object`（我们本来就在用），所以两层校验里"模型侧靠 strict 约束形状"这一层在这个端点**不存在**，四道闸是唯一还在的闸门。§12 R2 那句"有 key 后逐厂实测"的账因此只能算**部分还掉**：量到的是同一个端点上托管的几家模型，不是各家的官方端点。
- **P0：真实模型给根节点写的是 `"parentId": null`，而闸门把整批拒绝**（`packages/shared/src/graph.ts:13–23`）。第一次真跑 0 个节点，拒因逐字是 `parentId: Too small: expected string to have >=1 characters`——`z.string().min(1)` 对 `null` 报的就是这句。普查（`.scratch/llm-null-census.mts`）确认这不是某一家的手滑：`deepseek-v4.1-flash`、`qwen3.8-flash`、`qwen3.8-max`、`kimi-k3` **四个模型对每一个根节点都写 `null`**，而一次拒绝的代价是**整批、每一批**都进不去。修法是只把这个字段放宽成 `.nullish().transform(v => v ?? undefined)`，别的一个都不放（其余字段在真实输出里从未见过 `null`）。控制组：把 `nullish` 撤掉，`packages/shared/test/graph.test.ts` 的新测试红在同一句 `Too small…` 上——红信息与生产拒因同形，这才是有效对照。
- **这一条为什么单测抓不住（项目级陷阱，比上面那条更值得记）**：后端 `import "@rcc/shared"` 解析到的是 **`packages/shared/dist`**，而单测直接 import `src`。所以改完 `shared/src` 之后 `npm test` 全绿、真跑照旧全红，直到跑了 `npm run build -w @rcc/shared` 才 PASS。**判据不是"测试多不多"，是"被测的那份代码和被打进去的是不是同一份"**；任何改 `shared/src` 的活， Rule 8 里的 `npm run build` 在这一项上不是形式检查。
- **P0-2：推理模型把答案饿死在思考里**（`packages/backend/src/config/env.ts:52–62`、`llm/OpenAICompatProvider.ts:28–29`）。探针第一版栽过一次：`JSON.parse("")` 抛错把样本行吞了，改成"先记 `finish_reason` / `content` / `reasoning_content` 再 parse"才看清形状——`content` 是**空串**，token 全花在 `reasoning_content` 上，`readJson` 的空串兜底最坏返回 `null`，于是校验器报 `Invalid input: expected object, received null`，两次 repair 机会都用在同一件空事上。修法是把 `enable_thinking: false` 作为默认（`LLM_DISABLE_THINKING`，`true`）打在 `generate` / `stream` / `structuredGenerate` 三条路径上；实测同一批调用开着思考要 **27–106 s**，而 `LLM_TIMEOUT_MS` 默认 30 s。两个必须留字的边界：① **`glm-5.3` 直接拒绝 `enable_thinking:false`**，所以这个开关不是 universally 可发的，换模型可能要设 `LLM_DISABLE_THINKING=false`；② **它对 R1 这类"必须思考"的模型无效**——关不掉，只能靠更大的 `max_tokens` 与更长的超时去容纳。控制组：撤掉 `...this.thinkingToggle()` 后 `llmAdapterContract.test.ts` 红在 `expected undefined to be false`；而反向那条（`disableThinking:false` 时这个键必须缺席）在控制组下**正确地保持绿**，因为它锁的是缺席。
- **P1：`[00:10, 00:52]` 这种分组引用一条都不认**（`packages/backend/src/qa/citations.ts:14–30`）。旧 `CLOCK` 只认紧跟 `]` 的单个时钟，真模型的答法却是把多条引用挤进一副括号，于是"答案里明明标了时间，UI 上一条可点引用都没有"。修法改成两层：先 `BRACKET_GROUP` 取括号内整段，再在段内扫所有 `mm:ss`。放宽是有代价的，所以测试里专门钉住边界：`citations.test.ts`（5 条，新建）覆盖分组两条／相邻与带空格／**快照外的时钟丢弃**（§33 的原意）／**括号外的裸时间不认**（新放宽的下界）／同一 segment 只报一次。控制组：退回单时钟语义，`[00:10, 00:52]` 得 `[]`。
- **`kimi-k3` 拒绝 `temperature=0.2`**，而 QA 与导图都发这个数——这一格只登记，没改代码：换它做默认模型之前要先有一个"能接受还是该省略"的判断，而那是另一次花钱的实测。
- **默认模型那格的结论（`qwen3.8-flash`，一次 PASS）**：`storedNodes 8`、`opsByType {add_node: 8}`、标题最长 11 字（`over14=0`、`over40=0`——D-30 那两个上限因此至今没被真实输出触发过，"模型多常写超长标题"仍然没有频率数据，但**这次至少是真模型写的**）、`moduleErrors []`、两题 `degraded=0` 且分别带 3 条与 1 条可点引用、`loop_delay` p50 15.5 ms（Windows 定时器粒度，见 D-24）。
- **用户纠正了测量方式，这条要记成纪律**：我先前跑了 5 个模型 × 3 条 prompt 路径的兼容性矩阵，用户的评价是「**别用 qwen3.8-flash 呀，用 dsR1 这种小模型看能不能用就行了，你这是不必要的开销**」。教训不是"矩阵不该做"，而是**顺序错了**：应该先用最便宜的可用样本问一句"能不能跑通"，把 `parentId:null`、空 `content` 这类**结构性**问题挖出来并修掉，只有需要区分厂商时才付选型的价格。下面是照这个顺序做的一跑。
- **R1 小模型的可用性判定（`deepseek-r1-distill-qwen-1.5b`，一条 FAIL）**：流式问答**能用**——两题 447 字 / 287 字，`degraded=0`，第二题带回 4 条与快照对得上的真实引用。结构化路径**在当前预算下不能用**，3 条 `module.error` 原文：`{"module":"mindmap","code":"update_failed","message":"Request timed out."}`（30 s 见底）、以及 mindmap 与 memory 各一条 `structured output failed after 2 attempts: : Invalid input: expected object, received null`（就是上面那条空 `content` 链）。**"能不能用"的答案因此是分路径的，不是模型标签**：同一个模型在流式上合格、在 1200 token / 30 s 的结构化上不合格；要它合格得改 `max_tokens` 与 `LLM_TIMEOUT_MS`，而这已经超出"确认能不能用"的范围，本轮没做、也没再发请求。端点上可用的 R1 系 id 记在这里省得下次翻：`vanchin/deepseek-r1`、`siliconflow/deepseek-r1-0528`、`deepseek-r1-distill-llama-70b`、`deepseek-r1-distill-qwen-1.5b`。
- **两个"从来没有人生产过"的字段，登记为 OPEN-8 / OPEN-9，不顺手修**：① `withSummary` 在四个模型的普查里**全是 0**，而原因在代码不在模型——`prompts/mindmap.ts` 的 `OUTPUT_INSTRUCTION` 连示例 JSON 都没带 `summary` 字段，模型没有被要求写过它。后果是 `mindmapUserPrompt` 里的 `摘要=` 回喂和 `.mind-node` 的第三行 CSS 是两条死路径（`styles.css:322–372`）。② `speakerId` 零生产者零读者：`shared/src/types.ts:15` 有它，`store/transcriptRepository.ts:29` 写 `?? null`、`:86` 又读回对象，但没有任何 provider 填过、没有任何界面读它（本轮那次真跑的库里 697 行转写，非空 0 行）。两处都属本文件反复出现的那个模式——**schema 与样式先于行为存在**（同 §11/`graph_positions`、D-19/`mindmap_edges`、OPEN-4 的两张死表）。
- **Rule 8 闸**：`typecheck` 0 错、`biome lint .` **Checked 99 files，无诊断**、`npm run build` 通过、`npm test` **237 通过（30 文件）**、一次真 provider 端到端实跑（见上）。对账：与 D-30 那格（229 通过／29 文件）相比 **+8 条测试、+1 个文件**，分别是 `citations.test.ts`(5，新建)、`shared/test/graph.test.ts` 的 `parentId:null`(现 16 条)、`llmAdapterContract.test.ts` 的 `enable_thinking` 正反两条(现 11 条)。前端 `index` chunk 31.35 → **31.37 kB（gzip 11.07 kB）**，+0.02 kB，归因没测（候选是 shared 里那条 schema 放宽进包，但没有产物级 diff 证明）。本轮**没有新增任何第三方依赖**，`THIRD_PARTY.md` 不动。
- **不许读成已覆盖**：① 所有真 provider 证据都来自**同一个 DashScope 专属实例**（`/models` 列出 178 个模型），"逐厂 strict 支持程度"那一半仍没还（§12 R2）；② PASS 只有**一次**跑、8 个节点、2 题——不是样本量，任何"真实模型就是这样"的结论都还没到能被统计说话的程度；③ `enable_thinking:false` 的默认值在 `glm-5.3` 上会让请求直接失败，这条只写在注释与配置里，没有测试覆盖"拒绝这个键的端点"；④ R1 那一跑是"预算不够"的证据，**不是**"R1 不能用"的证据——没试过大预算；⑤ 引用解析改动没有浏览器级验证（UI 上引用条数对不对，本轮没看）；⑥ OPEN-8／OPEN-9 只登记，`summary` 与 `speakerId` 两条死路径仍在生产里；⑦ `.env` 里那个 key 已经在对话里出现过，交付前应当轮换。*（这一格后来由用户改判：**不轮换，开发结束后在控制台停用**——见 §13 补记「key 卫生」那一条。）*

---

**D-32 Test F 的 60–120 分钟区间跑满，Test A 第一次在真出画的页面上取数——外加一个差点骗过探针的陈旧后端**（2026-10-21，接 D-31；编号按时间）

这一轮没有写任何生产代码，做的全是"§56 那六条到底被证到哪一步"的取证，以及一次成本为零的复跑。

- **跑法**：后端与驱动都必须 **detached** 起进程（智能体单条命令上限 10 分钟，比 60 分钟短，见项目记忆「Verification workflow」）。`.scratch/launch-soak.mjs 60` 起后端 `:8791`（`MOCK_STT/LLM/EMBEDDING=true`、`DB_PATH=.scratch/rcc-soak60.sqlite`），`.scratch/soak.mjs` 每 30 s 采一次 `/api/debug` 并在 WS 上数帧、每 90 s 提一题，跑完自己发 `recording.stop` 再 exit。产物：`.scratch/soak-samples.jsonl`（120 行）、`.scratch/soak-out.json`、`.scratch/soak60-analysis.txt`、`.scratch/rcc-soak60.sqlite`（2 068 480 B）。
- **无泄漏（比 D-19 那一格长一倍，且斜率没有变陡）**：heap 25.9 → 31.3 MB，**斜率 0.08 MB/min**（31 分钟那场是 0.093），尾部减头部 3.2 MB；rss 79.0 → 86.3 MB（0.125 MB/min）；external 6.1 → 6.3 MB 几乎不动。`listeners` **全程恒在 19、最大值也是 19**——注意这一场只有驱动那一条 socket（16 个监听器 + 会话期 3 个），**与 D-19 的 35 不是同一个形状**：那场有浏览器，这一场没有，所以它测的是"单连接跑 60 分钟不涨"，不是"重载会回落"（回落那一格仍由 D-19 的两次 35→19→35 守着）。3.2 MB 增量对应 365 条有意留存数据 ≈ 8.8 KB/条，与 D-19 的 17 KB/条同量级（这场摘要块 18 个 vs 那场 10 个，驻留结构不同）。**同一条纪律仍然适用：这条只证成"增量与留存数据成正比"，不证成"绝对无泄漏"**，要区分二者得做 heap snapshot diff。
- **无节点丢失/重复**：库里 `transcript_segments 365 = mindmap_nodes 365 = graph_operations 365 = embeddings 365`；`sessions 1`，状态 `completed`；273/365 有父、**悬空父 0**；客户端侧 `dupAddNodeIds []`、`orphanParents []`；`frames` 里 `transcript.final 365 = mindmap.node.upserted 365`；`retrieval.indexed` 收尾 365、`dropped 0`、`skippedBatches` 末值 0。365 = 45.6 趟 × 8 行，与 60.05 分钟（脚本单趟 79 s）自洽。字幕间隔 p50 10 002 / p95 13 001 / **max 13 013 ms**——一小时后节奏误差仍是 13 ms 量级。
- **AI 请求不堆积**：`mindmap.update.requested` 143 次 = **2.38 次/分**，与 D-19 的 2.38 完全一致，正是 `MINDMAP_MAX_INTERVAL_MS=25000` 的上界；队列 `mindmap.pending ≤ 3`、`retrieval.pending = 0` 全程。问答侧 40 问 40 答、`degraded 0`、`answer.rejected` 无、TTFT 0–1 ms、`answer.token 5161`，`answersInFlight` 最大值 **0**。事件循环 p95 首末都是 16.2 ms（15.5 是 D-15 记过的 Windows 定时器粒度底噪），60 分钟里最差一窗 p95 26.3 / max 69.5 ms，比 D-19 那场的 24.9 / 90.8 更平。**`moduleErrors 0`、undecodable 帧 0。**
- **又抓到一条"有读有删没写"的复用**：`mindmap_edges` 在这场里仍是 **0 行**（365 个节点），`graph_positions` 也是 0（无人拖动）。D-19 那轮已经补上了写入路径，但 **Mock 语料从来不产生 `add_edge`**——所以"边能活过重启"这件事有单测、有写入代码，**却没有一次真实语料覆盖**，这一格与 OPEN-6 的 ⑤ 是同一笔账，不许因为表建好了就当已验。
- **UI 明显卡顿那一格，这场依然没有证据**：60 分钟压测全程无浏览器出画，帧率数据只能来自 D-26 的 500/1000 节点基准（1163 节点下 p50/p95/p99 全 17 ms、>50 ms 帧 0 次）与下面 Test A 探针的 `pageSocketToPaint`。**"跑满一小时"和"一小时里画面不卡"是两个观测面**，§14 里不许互相顶替。
- **Test A：一条判据在文档里躺了很久，却从来没有人在页面上看过它**。§56 的字面是「讲话：人工智能正在从大型语言模型逐渐扩展到世界模型。／字幕：2 秒内出现。」——它**指定了具体句子**，而此前 ADR 里所有字幕延迟数字都取在 STT worker 或线级（D-20/D-24），"2 秒内出现"是一句 DOM 观察，没有人测过。新探针 `.scratch/test-a-subtitle.mjs` 在无头 Edge 155 + 自写 CDP 里跑真页面，把四个区间分开命名上报（`wireToPaint` / `pageSocketToPaint` / `scheduledToFinalRow` / `partialBeatFinalBy`），并只判文档指定的那句（`MOCK_SCRIPT[3]`，`at:30 durationSec:4` ⇒ 定稿排定在 34 s），第 1 句留作对照。**正式读数（空闲机器，完整 JSON 存 `.scratch/test-a-result.json`）**：目标句 `scheduledToFinalRow` **26 ms**（预算 2000 ms），线级到达→上屏 12 ms，**页面自己收到帧→上屏 11 ms = 产品 UI 自身开销**，未定稿的半句「人工智能正在从大」早 **2.990 s** 已在屏上，`rowTextAtPaint` 是完整的 `00:30人工智能正在从大型语言模型逐渐扩展到世界模型。`；对照句 10 ms、UI 开销 3 ms；两个参照钟（段上的 `createdAt` 与 `recording.started + endTime`）相差 **-2 ms**。
- **参照钟的选法必须先说清，否则这 26 ms 会被读成"延迟"**：基准是**后端为这条 final 排定的时刻**（`MockSTTProvider` 的 `startedAt + segmentEnd*1000`），不是 `endTime`（那是语音时间偏移，正是项目记忆里的坑 5）。所以这 26 ms 量的是"这句话该出现 → 出现在屏幕上"，**不含任何识别耗时**，因为 Mock 的语料是脚本、不是麦克风。截图 `.scratch/test-a-page.png` 肉眼核对四行字幕与导图连线确实出画。
- **探针差点被一个陈旧后端骗过去，这条值得当环境纪律记**：Windows 把 Node 的 `UV_REUSEADDR` 映射成 `SO_REUSEADDR`，**重复绑定一个已占用的端口不报 `EADDRINUSE`**——所以 8787 上先前那场留下的后端（PID 30788）不会让新探针失败，而是与新后端**静默共用端口**，页面完全可能连到陈旧进程上取数。已补两道闸并让一次 PASS 运行同时通过它们：① 开工前探 `/api/debug`，有人应答就直接拒绝（"先按 PID 杀掉再跑"）；② 页面那条 socket 收到的每个 `segment.id` 必须以本次 `sessionId` 前缀开头（`shared/src/events.ts:43-47` 的 `sessionId: z.string().min(1)` 是唯一被契约保证的形状），出现异源段即判 FAIL。探针头注释里那条"没有 `/api/health`"要更正为：**有 `/health`（`apiServer.ts:34-42`），没有的是 `/api/health`**——就绪探针因此用 `/api/debug`。
- **Rule 8 复闸**：`typecheck` 0 错、`npm run lint`（`biome lint .`）无诊断、`npm run build` 通过、`npm test` **237 通过（30 文件）**——**与 D-31 的 237/30 逐字相同，而这是实测出来的不是假设的**：本轮往 `qaServer.e2e.test.ts` 的既有测试里加了两条断言（Test C 缺失的另外三条判据），加断言不加 `it()`，条数因此应当不变；一次实跑把这句话钉住了。日志 `.scratch/rule8-gate.log`。
- **顺带修掉三处 ADR 自己的引用不实**（模式：带引号的"原文"没回转录核对）：① D-19 曾把 §56 Test F 的**五条**"没有："并成四条，吞掉了「Transcript 丢失」；② D-19 与 §13 把"**最好继续测试：60～120 分钟**"算作 §56 的要求，实际那是 §53 Phase 9 的加强目标——规范字面只有「运行至少：30 分钟」，本轮的 60 分钟是**自设目标达成**，不是合规底线；③ §9 引 Test D 的提问时写成"约 10 分钟前"，那个「约」是我加的，文档字面是「他十分钟前是怎么定义这个概念的？」。三处都已在原处改正。
- **本轮同时收到四条交付形态决定**（用户在 2026-10-21 明确选择，逐条落到 §13 的对应格子）：OPEN-7 **不做服务端会话列表/自动续场，改为"单个会话的结构化导入与导出"**，导入后的会话要做到**可提问**（回看 + 检索问答，但永久 `completed`、不能再录音）；OPEN-8 **要摘要**，改 prompt 要求模型写；OPEN-9 **删掉 `speakerId`**；OPEN-5/6 剩余验收**只跑不需要人参与的那些，然后定稿**。这三条落地时的边界与既有地基（`qaRepository` 零读取、`graph_operations` 无 session 外键、向量是 float32 BLOB 等）记在 §13 新增的 OPEN-10，不在这里预写实现结论。
- **不许读成已覆盖**：① 60 分钟仍是 **Mock 语料**，真实 STT 路径的等长长跑最长只有 D-24 的 37.1 分钟；② `listeners` 恒 19 只证"单连接不涨"，重连累积那一格靠 D-25 的 5 次杀 worker；③ Test A 的 26 ms 不含识别耗时，麦克风那一半属于 OPEN-6，仍未被任何页面级测试覆盖；④ 这一格必须说白：**"UI 明显卡顿"在 Test F 的两场里都没有证据**，帧率数字来自另一场基准；⑤ `answersInFlight 0` 只测"不会自己堆死"，1.5 s 准入闸本身由 D-16 的单测守着，长跑没有触发它；⑥ `mindmap_edges` 的真实语料覆盖仍为零。

**D-33 节点摘要落地，以及一次被尺子骗出来的 CSS 撤销**（2026-10-21，接 D-32；编号按时间）

- **做了什么**：按用户决定「要摘要：改 prompt 要求模型写」，把导图节点从"只有标题"变成"标题 + 一句摘要"。落点是三处：`prompts/mindmap.ts` 的 `OUTPUT_INSTRUCTION` 新增第 5 条（每个 `add_node` 带 ≤40 字摘要、说明这个节点在当前语境里指什么、不复述标题），示例 JSON 同步加上 `"summary":"..."`；`MockLLMProvider` 两条 `add_node` 路径都补上 `nodeSummary(line)`；闸门把两个 LLM 侧 `summary` 字段放宽。**顺序是先改闸门再改 prompt**，理由见下一条。
- **先修的那条缝**：`LlmNodeSchema.summary` 原本是 `z.string().min(1).optional()`，而 prompt 一开始要求摘要，模型回 `"summary": ""` 就从"这一条没有摘要"变成**整批被丢**——和 D-31 那次 `parentId: null` 是同一个失败模式，只是这次是 prompt 主动把它请出来的。改成 trim 后为空即视作 undefined（`NodePatchSchema` 同改），并补一条判别测试：喂 `""` / `"   "` / 正常摘要各一条，断言 `rejected` 为空且只有第三条带摘要。**这条测试在没有放宽的版本上实测为红（1 failed / 16 passed），放宽后转绿**，不是推断。
- **一次付费请求，只花一次**：`.scratch/live-summary-probe.mjs` 用真实 prompt、真实闸门、空图、两句转写，发**一次**非流式调用（`temperature 0.2` / `max_tokens 1200` / `response_format json_object` / thinking 关，与 `OpenAICompatProvider` 的结构化路径同形）。结果：`qwen3.8-flash` 2.1 s 返回 1 个 `add_node`，`summary` = 「系统预测世界下一状态的能力，区别于LLM的词预测。」25 字（未超 40），没有复述标题；`parentId: null` 再次出现且整批通过闸门（accepted 1 / rejected 0）。用量 prompt 367 + completion 57 tokens。**要记的一处不合规**：用户的一般指令是"看能不能用就用最便宜的小模型"，而 `.env` 里 `LLM_MODEL` 钉的是 `qwen3.8-flash`，这一发就按它发了——单发量级可忽略，但这是**没有先核对选型就问价**，下次这类"只证能不能用"的请求应显式指定便宜模型。
- **`摘要=` 这行回喂第一次真正被用到**：`mindmapUserPrompt` 早就在相关节点行里输出 `| 摘要=...`，但在本轮之前图里几乎不存在带摘要的节点，那一行是死代码。现在它活着，等于把模型上一轮写的摘要回喂给它自己。Mock 侧不受影响：`MockLLMProvider.parseNodes` 的正则是 `title=([^\n|]+)`，遇到 `|` 就停，多出来的摘要段不会污染解析。
- **【否定结果，已撤销】一个被尺子骗出来的 CSS 改动**：摘要一活，节点盒子第一次要同时装下"两行标题 + 一行摘要 + 一行元信息"，而 `.mind-node` 是固定 88px + `overflow:hidden`（这个 88 与 `NODE_H` 的契约是 D-19/#49 量出来的）。第一版探针报"最坏情况元信息距裁切边 0.9px、几乎贴边"，据此把两处 `margin-top: 4px` 收到 2px。**这个判断是错的**：React Flow 的 `fitView` 在视口上留了 `scale(0.25)`，`getBoundingClientRect()` 拿到的是视觉像素，而 `paddingBottom`/`borderBottomWidth` 是布局像素，两者相减等于凭空放大 4 倍；同时 4px 的改动在视觉像素里只值 1px，正好解释了当时"收了 4px 却只回 1px"这个说不通的数字。把尺子修对（先除回 scale、再减 border/padding）后重测：**原 CSS 最坏情况元信息距裁切边 6.5px、底部 6px 内边距还剩 0.5px——没有任何裁切，也不贴边**。改动随即撤销，`styles.css` 回到 4px/4px 并用探针复测确认（shipped 与 `old-4px` 两档数字完全一致）。探针 `.scratch/summary-fit.mjs` 保留，它现在自带两个防自欺装置：URL 打穿 Edge profile 的 HTTP 缓存（否则量到的是上一版构建的 CSS），以及每行都打印**实测到的 margin 值**，让"数字来自哪张样式表"无法靠记忆。
- **Rule 8 复闸**：`npm run typecheck` 干净、`npm run lint`（`biome lint .`）100 文件无告警、`npm run build` 通过、`npm test` **240 passed / 31 files**（比 D-32 的 239 多 1，就是那条判别测试）。**改了 `shared/src` 必须先 `npm run build -w @rcc/shared`** 这条老规矩照旧执行，否则后端 import 的是 dist、单测 import 的是 src，会出现"单测全绿而生产全红"。
- **不许读成已覆盖**：① 摘要合规只在 `qwen3.8-flash` 上量到一发，deepseek / kimi / qwen3.8-max 是否同样会逐节点写 `summary` 没有证据；② 这一发是**空图 + 两句**，"图里已有节点时模型会不会为了省事只 `update_node` 不写摘要"未被触及；③ prompt 说 ≤40 字、闸门 `MAX_SUMMARY_CHARS` 是 160，两者没有对齐过，实测 25 字不构成证据；④ 视觉侧只证明了"不裁切"，没证明"摘要值得读"——摘要质量本轮不做判据。

**D-34 单会话导出/导入落地：身份改写规则被实测收窄到一列、`viewing` 做成状态而不是旁挂标志、以及一台量不出"落盘"的浏览器**（2026-10-21，接 D-33；编号按时间）

- **做了什么**：把 OPEN-7 决定的"单个会话的结构化导入与导出"做成可用表面。导出＝`schemaVersion` + 单会话 JSON（`GET /api/session/:id/export`，文件名 `session-<id>.json`）；导入＝`POST /api/session/import`，分配新 session id、写进同一台 SQLite、当场打开成**可提问的历史会话**（永久 `completed`、不能再录音）；向量不进文件、导入时重算；`graph_operations` 不进文件（它是审计日志不是状态）。OPEN-4 欠的读取侧一并补上（`GET /api/session/:id/questions`），它同时就是历史问答回屏的通道。
- **OPEN-10 登记时那条"全要手工改写"的担心，被实测收窄成一列**：登记时列了 `parent_id`／`mindmap_edges.source|target`／`summary_blocks.parent_block_id|source_block_ids`／`embeddings.owner_id`／`questions.snapshot_id` 五处要翻译。逐表读键（`sqlite.ts` 的 `SCHEMA` 才是真相，不是探查笔记）之后：`summary_blocks`、`embeddings`、`mindmap_nodes`、`mindmap_edges`、`graph_positions` 全是 `(session_id, …)` **复合键**，换 id 时把它们重打（restamp）做对，上面五处引用自动自洽——**不需要任何翻译表**。真正全局的只有 `graph_operations.op_id`、`questions.id`、`answers.id` 三张单列主键，而 `graph_operations` 根本不进文件，而**要改写的只有 question id 一处**（`${sessionId}-${originalId}`），`answers.id == questions.id` 这个不变量（`store/qaRepository.ts:80-82` 把 `answers` 的 `id` 与 `question_id` 都绑到 `answer.questionId`）跟着成立。收窄换来的是一条前置拒绝：目标 id 已存在就整单拒绝、一行不写。
- **两处实现约束是读码与红测试出来的，不是设计偏好**：① `TranscriptSegmentSchema.type` 是 `partial|final` 枚举，而 `SqliteTranscriptRepository.appendFinal` 遇到非 final **会 throw**——它在事务里，等于"文件混进一条 partial，整个会话回滚为零"，所以导入先过滤并把条数报成 `transcriptsSkipped`（单测覆盖）；② `SqliteEmbeddingRepository.putBatch` 自己开 `BEGIN`，所以重算向量必须在 `graphs.transaction` **外面**做，嵌套 BEGIN 是 SQLite 错误。重算失败不推翻导入：`counts.embeddingError` 带上原因，会话仍然可读可问，只是检索不到（用注入的失败 provider 测到这一格）。
- **`viewing` 是 `session.snapshot.state` 的第四个值，不是旁挂的布尔标志**：理由是每一个 gating 于"有没有活的东西在跑"的消费者，恰好也是每一个必须同时 gating 于"这一场是不是我能写的"的消费者——拆成两处早晚有人漏。查看态复用 `recording.current` 这一个槽位（`RecordingController.openHistory()`），所以 `/api/session`、WS 快照、`question.ask` 三条读路径零改动。`mindmap.start()` 故意不调用（D-31 口径：finished 会话里不该有写入者）；`memory.start()` 与 `retrieval.start()` 要调用——`RetrievalCore.search()` 只在 `closed` 之后返回空数组，而 `closed` 只有 `stop()` 会置上，所以查看态本来就能检索，`start()` 额外把 `embedded` 填起来，`/api/debug` 的 `retrieval.indexed` 才是真数而不是 0。
- **全新表面的登记（Rule 4 意义上）**：三条路由 + `OPTIONS /api/*` 手写 preflight + `bodyLimit` 32 MB。`access-control-allow-origin: *` 且无鉴权、后端只听 loopback ⇒ **本机任意一个网页都能读走一份导出文件**。今天可接受（Phase 1 是单机），一旦要放到局域网或公网，必须先加 token 再谈这条路。本轮**没有新增任何第三方依赖**：preflight 是手写的，没有引 `@fastify/cors`，`THIRD_PARTY.md` 不动。
- **实测**：REST 闭环 `.scratch/live-import-export.mjs` **29/29**（含同一份文件导入两次得到两场互不覆盖的历史、不合法文件被逐条拒且不留半写会话、查看态 `mindmap.busy === false && pending === 0`、每条引用的 `transcriptId` 确实躺在导入进来的段里、关掉后仍可再导出）；页面级 `.scratch/live-history-ui.mjs` **25/25**（真鼠标事件点按钮、徽章「录音 历史会话」、结束按钮改名「关闭历史」且可点、两个录音按钮 disabled、6 段字幕 + 6 节点 + 每个子节点一条边、录音时问过的那一题**不再提问就直接回屏**、新提问 14 ms 出泡、答案带 `[00:00]` 引用与总耗时）。页面第一轮 4 条红里 **3 条是尺子**：`File` 的名字必须在派发 `change` **之前**读（React 处理器自己清 `value`，一清 `FileList` 就空）；`.react-flow__edges svg` 是每层一个不是全页一个（实测 4）；树**不在** `document.edges` 里——`mindmap_edges` 只存 `add_edge` 造的交叉边，父子线来自 `parentId`，判据因此改成"每个有父的节点渲染出一条边"。
- **OPEN-7 那一问的答案，用两个进程钉死（`.scratch/live-restart-import.mjs`，7/7）**：A 进程录完、导出、被 kill；B 进程指向**同一个 SQLite 文件**起来。测到的形状是两件事，不能并成一句"支持恢复"：**重启本身不把旧会话放回屏幕**（`/api/session` 回 `state=idle, sessionId=null, nodes=0`，正是 D-30 量到的那个形状）；而**手里有那份导出文件，就能在一台从没见过它的进程里重新打开成历史会话并提问**（导入 → `viewing` → 答案引用的是重启前那几段转写）。中间那一格也测了：老 id 的行仍在盘上、按 id 指名仍能导出（`status=200`、6 段 6 节点），但**没有任何界面列出这些 id**——所以"没有文件也没有 id"时盘上的数据取不回来，这是承诺的形状，不是漏实现。
- **一条环境边界，差点被读成产品缺陷**：这台无头 Edge 155 会把它接受的**每一个下载**都 cancel。对照全落空（`.scratch/probe-download.mjs`）：blob + `allow`、blob + `allowAndName`、**同源 HTTP 直链** + `allow`，以及把下载目录换成纯 ASCII 路径——四种都停在 `downloadWillBegin → inProgress×5 → canceled`。中途还按"是不是产品自己把 blob 提前 revoke 了"（`sessionFile.ts` 确实 1 秒后 revoke）改测了一版永不 revoke，**同样 canceled**，于是这条嫌疑被排除。所以页面级的"导出"只能判到最后一个可观测瞬间：`Browser.downloadWillBegin` 带对文件名，加上把交给它的那段 blob 字节当场读回来校验（3247 字节、`session.id` 对得上、6 段 1 问答），并**用这同一份字节**去喂导入。真实浏览器里的落盘从未被证明。
- **Rule 8 复闸**：`npm run typecheck` 干净、`npm run lint`（`biome lint .`）**Checked 107 files，无诊断**、`npm run build` 通过、`npm test` **260 passed / 34 files**。对账：比 D-33 的 240/31 多 20 条 / 3 个文件，逐条归因＝`shared/test/sessionDocument.test.ts`(8) + `backend/test/sessionExport.test.ts`(4) + `backend/test/sessionImport.test.ts`(5) 三个新文件共 17 条，加 `qaRepository.test.ts` 读取侧那 3 条（`reads a session's exchanges back…`／`keeps an admitted question that never got an answer…`／`reads only the requested session`）。改了 `shared/src/protocol.ts` 的枚举照老规矩先 `npm run build -w @rcc/shared`，否则撞上"后端与单测不是同一份契约"那条坑；本轮这条坑的真实形状是前端 typecheck 报 `'viewing' is not assignable to RecordingState`——那正是契约加宽应有的爆炸半径，不是误报。
- **定稿前的一次全量引用对账，抓出三处失效锚点，其中一处就在代码里**：把本节所有 `file.ts:NN` 取出来逐个核（73 处，先查文件存在、再查行号是否还在文件长度内，然后读被指那一行看它是否真是那句话）。结果：① OPEN-10 登记与 D-34 都写"`answers.id == questions.id` 见 `qaRepository.ts:56-58`"，那三行其实是 interface 的字段声明，不变量的真身在 `store/qaRepository.ts:80-82`（`INSERT INTO answers` 把 `id` 与 `question_id` 都绑成 `answer.questionId`）。② D-34 往 `RecordingController` 里加了 `openHistory()`（`:63`）和 `stop()` 的 viewing 分支（`:129-136`），于是 D-30 那段引用的行号被这次交付自己推歪：`start()` 的 `randomUUID()` `:46→:86`、`stop()` 首句 `this.runtime = null` `:94→:143`、排空链 `:101-120→:150-169`；`MINDMAP_MIN_SEGMENTS` 在 `env.ts` 里是 `:156` 不是 `:146`。§14 表格里"§8 `ARCHITECTURE_DECISION.md:395`／`:404`"是自指行号——加一条 D 就必然失效，已改成按小节引。③ **最该记的一条**：`GraphStore.hydrate()` 的注释原文写着"Resuming a finished session is not wired"，而这句话被这次交付**自己作废**了——历史导图的装载器恰恰就是 `hydrate()`（`openHistory()` → `createRuntime()` → 构造函数 `SessionRuntime.ts:103`）。注释已按实测改写为"两个调用方的差别就是 OPEN-7 的全部内容"，§13 的 OPEN-7 补记里那句"`hydrate()` 的口径没有改向恢复历史"也跟着改成正面说法，因为它容易被读成"历史不经过它"。**这是同一老毛病的第二次显形**（第一次是 §11 的 schema 抄自设计文档）：代码与文档里的陈述不会因为改动而报警，所以凡是"改了产生它的代码之后还留着"的陈述，收尾时要重走一遍，不能只校对新增段落。改完之后复跑：Rule 8 四项再次全绿（`biome lint .` 107 files 无诊断、34 files / 260 tests 通过），`.scratch/live-import-export.mjs` 复跑仍 **29/29**——改的虽是注释、行为不该变，但定稿的这一格靠重跑，不靠推理。
- **不许读成已覆盖**：① 上面那条落盘；② 文件选择对话框不可驱动，`File` 是注入 `<input type=file>` 再派发 `change` 的——从 `file.text()` 往后是产品代码，之前那一步（用户真的选中一个文件）不是；③ 会话只到 6 段（Mock 4× 速度），**一份 60 分钟真会话的文件从未往返过**，32 MB 是按"一小时中文转写 + 导图 + 问答约数百 KB"推的，大文件导入的耗时与内存没有数；④ 重算向量用的是 Mock embedding，真 ONNX 下导入要多久没测；⑤ "导入 → 再导出 → 再导入"两跳后 `${sessionId}-${originalId}` 的前缀累积没测；⑥ 关掉历史后屏幕仍留着那场的 6 段字幕与 2 条问答（与「结束」同一既有口径），此时 `sessionId` 已空、「导出会话」按钮禁用——这是**测出来的行为**，不是判过对的设计；⑦ 没有多会话管理界面，导入即占用当前槽位，一次只看一场。

**D-35 后端自己伺服页面：一条安装包绕不开的前提，以及"`app.inject()` 量不到闸门"这件事**（2026-10-22，接 D-34；编号按时间）

- **为什么这不是"顺手加个静态目录"**：打包可行性那一格（#73）量到的硬事实是安装包不能带 Vite 与 devDependencies，而当时**页面是 `vite preview` 在 5173 伺服的**——也就是说整条交付链上没有一个是最终用户会打开的地址。所以这一格的内容就一句：让已经拥有 API 的那个进程也拥有页面。落法是手写（`packages/backend/src/server/staticFiles.ts`），与 D-34 那次"手写 preflight 而不引 `@fastify/cors`"同一条先例：**本轮没有新增任何第三方依赖**，`THIRD_PARTY.md` 不动（Rule 4 意义上的登记对象是三条：`/` 与 `/*` 两条路由、一个新配置项）。
- **形状**：`GET /` 发 `index.html`，`GET /*` 发构建产物里的同名文件；`STATIC_DIR`（`env.ts:146`，与 `DB_PATH` 同一条 cwd 相对口径，接口字段在 `env.ts:45`）指不到 `index.html` 时**一条路由都不挂**（`staticFiles.ts:94`）——这一条不是洁癖：不挂就没有 `/*`，源码开发照旧跑 5173，而 `test/helpers.ts:13` 故意把 `staticDir` 指到一个不存在的目录，否则"API 路由写错了一个字"会表现为 404 而不是 404-with-JSON，测试会静默变宽。挂载点在 `apiServer.ts:255`，注释在 `:30` 把"页面也走这个进程"这件事登记进那段"只有导出/导入两个 HTTP 面碰存储"的口径里：**页面读的是文件，不碰 store、不碰总线，所以 §20 那条"前端不能直接操纵图"的边界没有被这次改动扩大**。
- **闸门只认原始 request target，而这是一次实测出来的选择**：`resolveStaticFile()`（`staticFiles.ts:47-60`）先看字符（`staticFiles.ts:44` 的白名单里根本没有 `%`、`?` 之后截断、任何位置出现 `..` 即拒），再 `resolve()`，最后比对"是否仍以根目录为前缀"，且在 win32 上把两边一起转小写——Windows 大小写不敏感，精确串比对会让 `C:\ROOT\..` 与 `c:\root\..` 一个过一个不过。为什么不用 `request.params["*"]`：**实测**（`.scratch/probe-static-url.mjs`）路由器会把通配段**先 percent-decode**——`/..%2f..%2fprivate%2fsecret.txt` 的 `params["*"]` 是 `../../private/secret.txt`，而 `request.url` 仍是原始串；换句话说，取 params 等于在自己闸门前面多放一个解码器，那正是这条路径历史上被绕开的方式。
- **`app.inject()` 不能作为穿越的证据，这条得单独记**：同一份探针里，`inject` 会把 `/../x`、`%2e%2e/x`、`/./x`、`//x` **在进 handler 之前规范化掉**（`/../private/secret.txt` 抵达时已是 `/private/secret.txt`）；而真实 HTTP（Node 的解析器）**不规范化**，原始串照常到达——只有反斜杠会被它换成斜杠（`/..\..\package.json` 记成 `/../../package.json`）。后果很具体：`staticFiles.test.ts` 里那几条路由级穿越断言，红绿由框架决定，**不由被测代码决定**。所以穿越的判据换成两半：纯函数 `resolveStaticFile` 直接吃各种写法（4 个用例，其中一个遍历 9 种拒绝形态），真实 HTTP 用 `node:http` 的裸 `path` 发（`fetch`/WHATWG URL 会在客户端就把 `..` 解掉，用它测等于测浏览器）——11 种写法全部 404，且日志里 `static request refused` 计到 **11**，也就是每一条都是**闸门拒的**，不是"文件恰好不在"。
- **对照组必须先证明靶子存在**：`/../package.json` 被拒之前，脚本先用 `readFileSync` 读出该文件确实在磁盘上、内容含 `"name"`；同理 `/../.env`（那把 key 还在有效期内）与 `/../.scratch/*.sqlite` 也在拒绝名单里，最后再扫一遍日志与页面文本确认没有 `sk-` 形态的值出现。没有这一步，"404"完全可以是被测进程根本没在读文件。
- **缓存与类型是两条会真实咬人的规则**：`/assets/` 下（Vite 的 hash 命名）`max-age=31536000, immutable`，其余一律 `no-cache`（`staticFiles.ts:86`）——`index.html` 一旦被缓存，它指向的那批 hash 文件名在下次构建后就不存在了，用户打开的是一个 404 的页面骨架。`content-type` 按扩展名给死并附 `nosniff`（`staticFiles.ts:80-83`），认不出的一律 `application/octet-stream`；目录（`/assets`）走 `isFile()` 判据发 404，不发列表。
- **浏览器级探针抓到一条真红**：`.scratch/live-static-host.mjs` 第一轮 26 条里 3 条红，**2 条是尺子**（① 启动日志是 JSON，路径里的分隔符是双反斜杠，我用只吃单个分隔符的正则去比 `packages/frontend/dist`；② 我拿 `body` 的 `font-size` 当"样式生效"的判据，而 `styles.css` 从没设过它，默认的 16px 当然不变——换成 `cssRules` 计数 + `body` 的 `margin-top`/`background`，实测 sheets=2 / rules=159 / margin=0px / bg=rgb(16,20,24)）。**1 条是产品**：`index.html` 没有 `<link rel="icon">`，浏览器无论如何都会自己去要 `/favicon.ico`，于是在 8787 上多出一条 404——而"这个地址上没有失败的请求"正是安装包要交付的判据之一，留一个例外比补一行贵。已用 `packages/frontend/index.html:9` 的空 data URL 消掉，重建后该请求不再发生。
- **同源之后白捡的一件、和一次因此暴露的耦合**：页面与资产同源，`document.styleSheets[i].cssRules` 才读得到（跨源要抛 SecurityError），上面的 rules=159 就是靠这个量的。反过来，同源也是**构建期钉死的**：`packages/frontend/src/config.ts:2` 把 `:8787` 写进 `API_BASE`/`WS_URL`，页面 host 取 `location.hostname`——所以 `PORT` 一改，安装出来的页面就连不上自己的后端。本轮**没有**为它加配置面（不加 `VITE_*` 也不改成相对 URL），而是把"安装形态固定用 8787"作为交付约束记在这里；改这条的姿势应该是让 `config.ts` 跟随 `location.origin`，那是 #74/#75 之后值得做的一格，不在本轮顺手做。
- **非 loopback 现在是会被日志提醒的一件事**：`index.ts:116-121` 在 `HOST` 不是 `127.0.0.1`/`localhost`/`::1` 时 `log.warn`。动机与 D-34 那条"`access-control-allow-origin: *` 且无鉴权、只听 loopback"是同一件事，只是这次把整个 UI 也放到了这个 socket 上——而 key 要到开发结束才被停用，所以"别把这台机器上的东西挪到局域网"仍然是活的约束，值得在日志里留一行而不只在文档里。
- **实测（Rule 8 第五项）**：`.scratch/live-static-host.mjs` **26/26**。其中页面侧：`document.title` 正确、`#root` 已挂载、样式规则读得到、CDP `Network` 全程 `loadingFailed` 为 0、到本源的每条响应都 <400、控制台 0 条 error、「连接」徽章为「已连接」（同源 WS 真的握手了）；行为侧：点「模拟讲解」→ 6 条字幕 + 6 节点 + 4 条边 + `svg=4`（真出画，非 D-19 那种停画出画的假象）→ 提一题得到 2 条 `[mm:ss]` 引用；后端侧 `/api/debug` 同时报 `state=recording`、`nodeCount>=3`，证明页面驱动的就是它自己那个会话。截图 `.scratch/static-host-page.png`（107 KB，真像素）。
- **Rule 8 复闸**：`npm run typecheck` 干净、`npm run lint`（`biome lint .`）**Checked 109 files，无诊断**、`npm run build` 通过、`npm test` **269 passed / 35 files**。对账：比 D-34 的 260/34 多的 **9 条 / 1 个文件全部是 `packages/backend/test/staticFiles.test.ts`**，没有其他条数变化。测试文件照旧不在 `packages/backend/tsconfig.json` 的 include 里，所以另跑了一次手动的 `npx tsc --noEmit … packages/backend/test/staticFiles.test.ts`，**exit=0**（不是"只看新出现的行"，这个文件本来就干净）。配置项按名对账：`env.ts` 读到 38 个变量名，`.env.example` 列 38 个，**双向差集为空**。
- **不许读成已覆盖**：① 没做 SPA fallback——深链一律 404，依据是"本项目没有前端路由"，这条依据成立与否没被测试覆盖过，将来加路由就要一起加；② 没做 `content-encoding`（gzip/br），资产原样发送，`vite build` 报告里那些 gzip 数字是 vite 的估算不是本服务的行为；③ `.map` 现在照样能被发现并取回（三个 map 合计 2 557 156 字节，占 dist 3.0 MB 的绝大部分），本轮没为此写任何规则——**安装包该不该剥掉 map 是 #74 要判的**，判之前这里既是体积问题也是源码可见性问题；④ 穿越名单是 11 条常见写法，不是穷尽；⑤ 只验了 Chromium 系（Edge 155）与 `MOCK_*` 全开那一档；⑥ `STATIC_DIR` 换到别的盘/别的相对位置、以及 dist 是符号链接的情况没有测过——前一个是安装路径问题，后一个是这个前缀比对的已知盲区（`resolve()` 不解析 symlink）。

**D-36 交付形态定稿：一个必装核心 + 三个可选模块，以及 IExpress 被逐条证否之后改走的那条编译路线**（2026-10-22，接 D-35；编号按时间）

- **被问的那个问题不是"要不要勾选框"**：用户原话「可不可以自己选模块装」问在可行性数字之前，而量到的三条硬事实决定了形状：① 生产依赖全树 **521 MB**（`onnxruntime-node` 288 M + `onnxruntime-web` 141 M + `@huggingface/transformers` 14 M）；② 剥掉 transformers 整棵子树之后核心只剩 **64 个包**，加 `runtime\node.exe` 与三份 dist 实测 **4452 个文件 / 115.3 MiB**（#73 按清单估的是 ≈144 MB，走树之后比估算小 20 MiB，差在没把 `docs`/`var` 与重复副本算细），压成自解压 **40.6 MiB**；③ M2/M3 是 **658.1 / 530.7 MiB 的纯数据**。所以答案是**四个包**而不是一个带勾选框的包：`RCC-Core-Setup.exe`（必装，Mock 全功能）+ `RCC-M1-Setup.exe`（真实 embedding 运行时，装进核心所在目录）+ M2/M3 **目录加装**。分层依据是读码得到的、并被实跑复现：`@huggingface/transformers` 只在 `retrieval/embeddingWorker.ts` 被 import，而 worker 只在 `config.embedding.mock === false` 时才构造、才 spawn ⇒ Mock 档根本不碰它。把 658 MB 权重塞进一个托管资源没有任何收益——"数据不需要装"和"体积不允许装"两条同时成立，这才是 M2/M3 不做成 exe 的理由。
- **打包的是闸测过的那一份**：staging 从**安装态** `node_modules` 逐 importer 走依赖闭包，所以 npm 的嵌套重复副本被原样保留（实测到 `fast-uri`、`onnxruntime-common` 各有多份），不做 hoist、不联网、不跑 install 脚本——npm 在本机会拦 postinstall（实测 `protobufjs@7.6.6` 被 allow-scripts 拦下），任何"装完再 build 一下"的假设在一台离线目标机上都失效。`core` 是唯一拷贝构建产物的档位，因此它是唯一可能静默装进旧 `dist` 的档位，脚本对这一点单独设了 `assertBuildProducts()`。
- **IExpress 是被矩阵证否的，不是被一次失败否决的**：`iexpress /N` 会起 `makecab.exe`，手工调用 `makecab` 成功，但中间柜从未生成，每种构型最后磁盘上只剩那个 172 032 字节的桩。跑遍的构型：八种 SED 形状 × `/N`、`/N /Q`、`/N /A /Q`、裸跑 × `InsideCompressed` 0/1 × `InstallApp` / `RestoreFiles` × 中文 cwd / ASCII cwd × TEMP 挪到 ASCII 路径——结果逐字相同。`.sed` 语法不是问题，所以换路线而不是继续调 SED：改用 Windows 自带的 `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` 编译 `tools/installer/Setup.cs`，把 `payload.zip` 作为托管资源内嵌，产出单个控制台 Setup.exe。代价写清楚：那是 pre-Roslyn 的 csc，只有 C# 5 / .NET 4.0 语法。白捡的两件好处也是实测的：**不再受 codepage 936 限制**（用户可见中文进 UTF-8 资源，中文安装目录与中文 label 直接可用），**目标机不需要 bsdtar / makecab / 向导**（解压走 .NET 自带 zip）。产出物是普通未签名程序集，SmartScreen 首跑会警告——属签名问题，登记不在此绕。
- **一条只有 Windows 会犯的错，它变成了闸门**：探针曾传 `--build=D:\rcc-build` 而 `--staged=D:\rcc-build\mini`、`--name` 取默认，于是 `work` 算成 `D:\rcc-build\MINI`——**与 `staged` 同一个目录，因为 Windows 路径大小写不敏感**。`tar` 把正在写的 `payload.zip` 打进包里，产出一个只含 1 个 0 字节条目、退出码 0 的"空安装包"，直到装完再看一眼的检查看见它。现在 `assertDisjoint()` 在任何删除动作之前跑（清理会先把被它保护的树删掉），重叠就拒绝构建。同一批口径：cmd 自己的消息是 codepage 936、node 子进程的输出是 UTF-8，解码器混用会把中文变成 mojibake——本轮就把它用错了一次，Setup.exe 的 stdout 用 gbk 解出来是乱码，而 exe 本身没问题。
- **台账被自己的产品决定否掉**：`installed-modules.json` 是安装时刻写下的清单，而 M2/M3 的交付形态恰恰是"用户事后往 `models\` 里拷一个目录"——一份安装时写的清单不可能知道那件事，菜单会稳定地报错误状态。所以现在**没有台账文件**，只有一个派生函数 `deriveModules()`（`packages/backend/src/observability/modules.ts`），三个读面共用它，因此三者不可能互相矛盾：`RCC-modules.bat`（应用停着也能读）、`/health.modules`、启动时的逐条日志。判据必须与应用自己的规则同形，这条是被实跑逼出来的：M2 要看 `<EMBED_MODEL_DIR>\<EMBED_MODEL 拆段>\onnx\*.onnx` + `tokenizer.json` 且**跟着 `EMBED_MODEL` 走**（装着另一个模型不算数）；M3 复刻 `services/stt-worker/stt_worker.py` 的 `validate_model_paths`（`tokens.txt` 且（encoder/decoder/joiner 三件套 或 单个 `model*.onnx`））——理由一句话写在测试名里：**会说谎的菜单比没有菜单更糟**，worker 起不来的目录不能标成"已装"。`modules.test.ts` 8 条，含"半拷的模型算未装"与"缺 `tokens.txt` 拒不认"。
- **回落的方向盘在用户手里，不在我手里**：`MOCK_EMBEDDING=false` 而模块缺失时**不静默换成 Mock**（§50 禁的正是这个），provider 保持 `onnx:Xenova/bge-m3:q8`，检索按次大声失败；同时把话说清在三处：启动一条 **error** 记录带 `missing` 清单 + remedy + 后果（录音、导图、摘要不受影响；装好模块重启即恢复；也可以自己把开关改回 true），`/health.modules` 每项带 `checked` 与 `remedy`，`RCC-modules.bat` 逐条给"检查过哪里 / 怎么装"。缺 M3 同理只 warn，并且提示还要另开终端启动 worker。M1 与 M2 都齐但 `.env` 仍是 `MOCK_EMBEDDING=true` 时，菜单反过来提醒一句"现在用的是 Mock 检索"——这条是最容易出现的"装了但没用上"。
- **打包探针抓到两条产品级缺陷，两条都不是检视能发现的**：① `{ message }` 把日志标签吃掉——11 处调用点把错误文本写成 `{ message }`，而 `{ ts, level, message, ...fields }` 让字段**覆盖**记录自己的标签，于是 `embedding worker stopped` 与 `retrieval search failed` 在 grep 里成同一行、无法分组，而全仓库的判定恰恰是按 `message` 分组数的。修法不是去改那 11 处，而是把保留名映射掉（`message→detail`、`level→detailLevel`、`ts→detailTs`），因为"调用点写错"是会重演的事。第一版把三个保留名都映射到同一个 `detail`，我自己新写的判别测试立刻红（`Expected: "yesterday"  Received: "nonsense"`），那正是最后写入者胜的数据丢失，遂改成唯一名映射；`log.test.ts` 3 条钉住。② `retrieval_search` 的 `candidates: 0` 有两种读法：**索引从未填起来**，或者**每一句都还在 Hot Context 窗口里**（`QaCore` 把窗口内已有的行从候选里排除，免得一句话被引用两次，`qa/QaCore.ts:74-77`）。一场比 `HOT_CONTEXT_SEC`（默认 240 s）短的会话必然给出后者，而验收脚本第一轮把它读成了前者、差点判成"加装没生效"。现在同时报 `scanned`（排除前）与 `candidates`（排除后），加装那一档的真实读数就是 `scanned=6 candidates=0 hits=0`：6 条真向量确实在库里，是窗口把它们全占了。`retrievalCore.test.ts` 钉住这个区分。
- **M3 的 staging 此前是错的**：第一版把 `.probe-model` 整棵树（缓存 tar.bz2 + 探针脚本 + 两个模型目录）一起拷走，1.1 GB 里只有一部分是模型。现在 `stageModule("m3")` 先用与 `deriveModules`、`stt_worker.py` 同形的 `isSherpaModelDir()` 判定来源，**不合格直接拒绝打包**，合格的目录保留自己的名字放进 `models\stt\<名字>`（菜单里那句 worker 命令带的就是这个名字，改名等于说谎），并把 `services\stt-worker\requirements.txt` 附带进该目录。实测 16 个文件 / 530.7 MiB。
- **跑法与判据（Rule 8 第五项，两次真装真跑，全绿）**：`.scratch/live-modules-stripped.mjs` **19/19**——干净核心装完 → 菜单三条未装且每条带 checked/remedy → `/health` 的 provider 仍是 `onnx:Xenova/bge-m3:q8`（判据专门用来排除"看起来像真跑"）→ 录音照出 6 条 final → 提问仍有答复 → 启动 error 记录带 `missing:["m1","m2"]` → 日志里没有 `using mock embeddings`。`.scratch/live-modules-added.mjs` **13/13**——**同一个目录**里装 M1（`RCC-M1-Setup.exe --target=<已有目录>`，5.1 s，不重装核心）+ 拷 M2 目录（0.9 s）→ 菜单转成 [已装] → `embedding model ready` `dim=1024 loadMs=3368` → 6 条 `embedding_batch ok:true`、`retrieval_search scanned=6`、provider 是 ONNX 名、嵌入/检索链路里 `provider=mock` 的行数为 0 → 停止按记录的 PID。交付目录 `%LOCALAPPDATA%\Programs\RCC` 已用同一批产物刷新（核心 4452 文件 / 115 MiB，M1 1488 文件 / 435 MiB，M2 就位），`.scratch/live-launcher.mjs` 走它自己的 `RCC.bat` / `RCC-stop.bat` **8/8**，含"页面由装出来的应用伺服"。**store 层的证明不靠打开 sqlite**：`RCC-stop.bat` 是 `/F` 强杀，库可能还在 WAL 恢复中，所以取证取自应用自己的指标行。此前 #75 的两个目标 × 32/32 与 launcher 链 8/8 是同一套判据在旧构建上的读数。
- **D-36 补记（2026-10-22，文档轮之后重新出一份核心包）**：上一条里的 4452 文件是"文档定稿之前"的读数。新增本项目的开发过程说明 `docs/DEVELOPMENT_PROCESS.md` 之后重新 staging + 重新编译：**4453 文件 / 115.4 MiB**，`payload.zip` 40.6 MiB，`RCC-Core-Setup.exe` 装进一个全新目录（`--quiet --target=`）实测 status=0 / 4.8 s / 4453 文件落地，`installed-modules.json` 仍然不存在（台账已删），`docs/` 里四份文件齐。那个新目录用它自己的 `RCC.bat` / `RCC-stop.bat` 复跑 **8/8**，`/health.modules` 三条都报未装且各带 `checked`/`remedy`——正是"只装核心"应有的形状。交付目录 `%LOCALAPPDATA%\Programs\RCC` **只替换了四份文档与 `README.md`，载荷一个字节没动**，复跑仍 **8/8** 且 `modules` 为 m1 已装 / m2 已装 / m3 未装。**19/19 与 13/13 两次模块验收是在"与交付物只差这几份文档"的构建上读的**，这句话必须和那两个数字一起引用。
- **不许读成已覆盖**：① **改 `PORT` 之后装出来的页面连的还是 8787**：`packages/frontend/src/config.ts` 把端口写死（D-35 已记为交付约束），而本轮所有安装态探针都用 `PORT=` 覆盖去驱动 API/WS——那条路验的是后端，不是页面里的 JS。默认 8787 的交付形态被 8/8 覆盖过，改端口没有，登记 **OPEN-11**；② 没有卸载器：Setup.exe 不写注册表、不建快捷方式（按 `Registry`/`.lnk` 在源码里搜过），所以"卸载＝删目录"成立，但这句话没有测试证明过，且 `var\` 里的库与日志会一起消失——要不要保留数据是产品问题；③ exe 未签名，SmartScreen 首跑必警告；④ M2/M3 是目录加装，菜单给的是 `checked` 路径而不是校验和，"用户把目录放错了地方"这类误装没有任何测试覆盖；⑤ 4452 文件 / 64 包是**这台机器安装态**走出来的树，换一次 lockfile 解析结果就可能不同，脚本按磁盘走、不按清单猜；⑥ 加装那一档里 `MOCK_LLM` 仍是 true，所以 `qa_answer`／`mindmap_update`／`summary_block` 三行 `provider=mock` 是预期——脚本第一轮把这条读成了缺陷，判据已按链路收窄；⑦ 麦克风时长与中文 WER 照旧未覆盖（要真人）；⑧ 产出的 exe 需要目标机有 .NET Framework 4.5+（`System.IO.Compression` 取自 GAC），这台机器满足，别的机器上"找不到编译器/找不到程序集"那两条退出路径没被测过；⑨ **`.map` 与 `.d.ts` 被刻意排除在包外**（`tools/package.mjs:123-126`），D-35 ③ 留给 #74 判的那格就此有了答案：源码可见性与体积两个问题一起解决，代价是装出来的应用崩了之后**没有可读的堆栈行号**，排障要靠 §47 那批指标行——这条取舍没有实测过（没在装出来的应用里制造过一次真崩溃）。

---

## 7. LLM Adapter 设计

**决定：用官方 `openai` SDK 打 OpenAI 兼容端点，自写 ~50 行的 `LLMProvider` 接口；不用 Vercel AI SDK、不用 LangChain。**

- 理由：DeepSeek / Qwen(DashScope) / GLM(Z.ai) / Kimi 全部提供 OpenAI 兼容 `/v1` → **换 provider 只改 baseURL+key+model 字符串**，接缝天然存在；MVP 明确只要"1 个正式 + 1 个 mock"（设计文档 §34），AI SDK 的 provider 生态与 v6→v7 API 漂移是净负担；LangChain/LangGraph 与设计文档 §19「非必要不引入复杂 Agent Framework」直接冲突，社区共识亦为线性单次流程用它是过度设计。
- 被否：`Vercel AI SDK v7`（若将来要同时接 3+ provider 且要 `partialOutputStream` 流式半成品 JSON，再引入不迟）；`LangChain/LangGraph`（过度设计）；`LiteLLM/one-api/new-api`（1 provider 时是纯增运维，且 **new-api 是 AGPL-3.0 + 去品牌需商业授权**）。
- Mock Provider：实现同一接口，返回确定性假 `GraphOperation[]` 与假流式答案，供 `MOCK_LLM=true` / 无 key 环境 / E2E（设计文档 §50）。

**结构化输出的两层校验（Phase 2 定稿，实现在 `shared/src/graph.ts` + `OpenAICompatProvider`）**

| 层 | Schema | 失败处置 |
|---|---|---|
| 模型输出（LLM-facing） | `GraphOperationInputSchema`：`type` 上的 discriminated union，`opId` **可选**，`title/id` 必填 | repair：**最多重试 1 次**，把 Zod issue 追加进同一 user prompt；仍失败 → `LLMStructuredOutputError` → 丢弃本批 + `module.error` |
| 系统内部（权威写入） | `GraphOperationSchema`：`opId` 必填 + `stampedAt`，由 `parseGraphOperations` 归一化产出 | 语义闸门：`orphan_parent`/`unknown_node`/`duplicate_op`/`duplicate_node_id`/`self_relation`/`cycle` → **discard+log**（设计文档 §45） |

- **repair 上限与传输重试解耦**：`MAX_REPAIR_ATTEMPTS=1`（写死在 adapter）而不是复用 `LLM_MAX_RETRIES`。否则默认配置下 3 次传输重试 × 3 次 repair = 单次 flush 最多 9 个请求，且全程持着 single-flight 锁——这正是 Test F 禁止的"AI 请求堆积"。
- **两层用同一个 per-op schema 是有意的**：若 adapter 只做宽松校验（早期实现是 `z.array(z.unknown())`），形状非法的 op 会在 reducer 门口被静默丢弃，repair 循环**永远不会触发**——等于 §45 的修复通道是死代码。语义类拒绝（父节点不存在、成环）只能在第二层判，留在 `parseGraphOperations`。
- **orphan buffer 按 batch 内重试**（§12 R2 的第四道闸）：模型不保证先说父亲再说孩子，所以引用了"本批后面才会创建的 id"的 op 先 hold back，每个 pass 只要还有 op 能挂上就再来一轮；某个 pass 零进展才落成 rejection。原顺序的 `opId`（`responseId:index`）保持不变。
- 成环的第二重保险在 reducer `applyOperation`（graphEngine.ts:139，环判定在 `:184` 与 `:201`）里：它对着**正在演化的状态**逐 op 判 `exists` 与 `isDescendantOrSelf`，所以同批内新建节点造成的环也拦得住。前端应用 WS 帧走同一个 reducer，两层同源。
- 证据：`llmAdapterContract.test.ts`(11) 与 `mindmapWire.test.ts`(5) 打**本地 OpenAI 兼容 HTTP/SSE 端点**（`test/llmStubServer.ts`，不需要 key），覆盖 fence/prose 恢复、repair prompt 内容、give-up、503 降级只伤地图、repair 上限=2 次调用、`enable_thinking` 正反两条；`shared/test/graph.test.ts`(16) 覆盖 gate 本身。真 key 接上之后又补了一条**端点级**事实：`json_schema` strict 在这一家上不可用（见下条"模型选择"的更正），所以这张表的第一层能倚靠的只有 `json_object` + 我们自己的 Zod，闸门没有第三层。

**Prompt 管理**（设计文档 §35）：`packages/backend/src/prompts/{mindmap,qa,summary}.ts`，禁止散落在组件/controller。

**模型选择**：正式 = **DashScope Qwen-Flash/Plus**（中文原生 + OpenAI 兼容 + 有免费额度，测试成本最低）。备选 GLM-FlashX（~200 tok/s 实时调优）。**禁用 thinking-only 模型跑 QA**（TTFT 超预算）。
⚠️ 价格数据来自二手来源，**上线预算前必须官网复核**。
🔴 **2026-10-21（§6.5 D-31）实测更正两处，这一格原先的两个断言都有错**：① **"支持真 strict `json_schema`"不成立**——在这套专属实例上 `response_format={type:"json_schema", strict:true}` 直接回 `This response_format type is unavailable now`，可用的只有 `json_object`。选型时把 README 的"结构化输出"读成了"strict 模式可用"，又一次印证 Rule 4 那条"零二次开发/自带/支持"这类词必须落到一次可复现的调用上（与 D-20 的 sherpa "自带 websocket server" 同源）。② **`enable_thinking` 不是可普发的键**：qwen / deepseek / kimi 接受 `false`，而 `glm-5.3` 拒绝它；反过来 `kimi-k3` 拒绝我们一直在发的 `temperature=0.2`。③ "禁用 thinking-only 模型跑 QA" 这句现在是**有数的**：同类调用开着思考实测 27–106 s，而 `LLM_TIMEOUT_MS` 默认 30 s，所以这一格从"经验法则"变成"配置约束"（`LLM_DISABLE_THINKING` 默认 `true`）。仍然没测的是各家的**官方**端点——本轮量到的模型都托管在同一个 DashScope 实例上。

---

## 8. MindMap 渲染与布局（本项目最难的需求，设计文档 §18/§25，验收 Test B）

**决定：React Flow（MIT）+ 自持坐标 + 仅对新子树跑 `d3-hierarchy`。**

决定性洞察：React Flow **没有内置布局引擎** —— `position` 必须由调用方提供，除你的代码外没有任何机制会移动节点。于是"加一个节点不许重排整图"**是结构性成立**，而不是需要跟库搏斗。这是它击败所有"开箱就像导图"的专用库（jsMind / mind-elixir / simple-mind-map / markmap 全部自持模型并在结构变化时重跑整树布局）的根本原因。

布局状态与内容分离（Zustand）：`graph`（`nodes`/`childOrder`/`edges`，纯 reducer 产物）+ `positions:Record<id,{x,y}>` + `pinned`（用户拖拽覆盖）+ `collapsed`。
- 实际落地的函数是 `layoutGraph(state, known, pinned, collapsed)`：对 `childOrder[ROOT]` 里的**每一棵顶层树**分别取锚点 `pinned[root] ?? known[root] ?? {x:0, y:cursorY}`，树内用 `d3-hierarchy.tree().nodeSize([NODE_H+ROW_GAP, NODE_W+COLUMN_GAP])` 算 tidy 相对坐标，再 `锚点 + 偏移` 展开；`pinned[id]` 最后覆盖，用户拖过的节点连布局都不参与。
- 于是"加一个叶子不会整图重排"是**按树**成立而不是按节点成立：新叶子只会让自己那一棵顶层树内部重新平衡，别的树锚点早已冻结。Phase 0 设想的 `childCursor`（每父节点递增 y 偏移、绝不回写已有坐标）比这更强，但它在真实模型面前守不住——模型会在任意深度插节点，一个不回写的游标必然重叠。**已按实测代码修正，勿再照 `childCursor` 描述读这份文档。**
- 锚点语义的实跑证据见 §6.1 D-17：拖走一个顶层节点后重载，它停在拖到的坐标、它的四个子节点整体跟着平移 236 px、另一棵没碰过的树仍在 `x=0`。Test B 从"结构上大概不会跳"变成"有断言且实跑一致"。
- 全局 tidy（ELK layered + Web Worker）**未落地，也不在本阶段落地**：`elkjs` 连依赖都没进（其许可证是 EPL-2.0/GPL-2.0 可选，见 §10），而 §43 要的是"不整体重排"，d3 的每树 tidy 已经满足。它只属于"用户手动一键整理"这种产品动作，等有人要再评估许可证。
- 弃 dagre：0.8.5 于 **2019-12 冻结至今**，且 `layout()` 覆写所有节点坐标，无 fixed 概念。

**30–120 分钟防泄漏纪律**：大段 transcript 正文不进 `node.data`（只存 title + `sourceTranscriptIds[]`）；`nodeTypes/edgeTypes` **提升到模块作用域**（重建会造成全节点 remount，React Flow 最经典的泄漏陷阱）；`onlyRenderVisibleElements` + 默认折叠 depth>2–3；单次 LLM 响应的 ops 在 ~500ms 窗口合并成一次 `setNodes`。

- **⚠️ 这一段是 Phase 0 的清单，四条里有两条从没落地，别照它读代码**（2026-10-20 逐条核过）：① 正文不进 `node.data` **已做到**（`buildFlow` 只塞 title/summary/confidence/childCount 这些）；② `nodeTypes` 在模块作用域 **已做到**（`MindMapView.tsx:35`）；③ **`onlyRenderVisibleElements` 没开**，`<ReactFlow>` 上只有 `fitView` 与 `minZoom`；④ **默认折叠 depth>2–3 没有**——折叠机制存在（`collapsed` slice + 节点上的 `+/−` 按钮），但初始状态一律展开，只有用户点过才折；⑤ "合并成一次 `setNodes`" 是**以另一种形式成立**的：前端每收到一帧 WS 就调一次 `applyOps`，一次 `set` 触发一次布局与一次 `buildFlow`，所以批次边界由后端的 flush 窗口（`MINDMAP_MAX_INTERVAL_MS=25000`）决定，前端没有第二个 500 ms 窗口。
- **⚠️ D-26 一度把大图下的 0.3 s 上屏延迟归咎于"每批重建全部节点对象"，并据此认为下面这两条缺失是主因——实验推翻了它**：给 `buildFlow` 加节点引用缓存（跨树批次 0% 复用、单树 62%、钉住的分支 94%）之后 paint 一格没动；`onlyRenderVisibleElements` 把 DOM 从 1163 压到 29 个节点之后仍然 229 ms。**所以"开这两个开关就能修"不是结论，是待验证假设**（默认折叠至少还会改变用户看到的地图形状，属 §58(d)）。真实成立的部分是：我们自己的派生代码只占 4–9 ms/批，改它修不了那 200 ms。详见 §6.2 D-26 同日更正。

**D-23 前端产物分包（构建配置，不是架构决策）**：构建曾是一个 523.87 kB（gzip 163.42 kB）的 chunk——改一行自己的代码就得让用户重下整个 React Flow。`vite.config.ts` 现按包名切出 `vendor-react`（react/react-dom/scheduler）与 `vendor`（其余，含 `@xyflow/react`），实测 `vendor-react 206.80 kB` + `vendor 287.15 kB` + `index 29.12 kB`（gzip 10.10 kB），CSS 随之分成 `index 4.24 kB` + `vendor 15.41 kB`。**总体积没有变小**，这不是体积优化；收益是自有代码的增量下载从 524 kB 降到 29 kB，两个 vendor chunk 的 hash 不随业务改动变化。验证方式：`vite preview` 服务构建产物，点「模拟讲解」→ 字幕时间戳与导图节点照常出现、console 零消息（分包不改变加载语义，全部仍是 eager 加载）。

---

## 9. Memory 与检索（Phase 6/7 已定稿，真实 embedding 模型已于 7d 接入）

设计文档 §29/§30/§31 要求：Hot Context(3–5 分钟原文) + Summary Blocks + Embedding Retrieval + MindMap 节点 → 组装 Context Snapshot。

已定的架构约束（与模型选择无关）：
1. **向量与元数据同库**：向量必须落在同一个 SQLite 文件，不接受独立向量数据库服务（无 Docker、单机、2 小时约 3000 段）。
2. **规模判据**：3000×1024 float32 ≈ 12 MB，暴力 cosine 在毫秒级 → **默认不引入 ANN**，除非实测证明不够。（Phase 0 写的"毫秒级"是估算；§9.2 D-6 的实测是**几十毫秒**，慢一个数量级，且是同步阻塞。据此把"证明不够"的阈值定成 3000 行 / p50 100ms，而不是推翻本条约束。）
3. **Embedding 推理不得进主 loop**（见 §2 的 child_process 结论）。
4. **Context Snapshot 冻结语义**：问题提交时把 hot/retrieved/summary/nodes 拷成不可变快照再送 LLM，新到的 transcript 不改本次上下文（设计文档 §32）。
5. **SummaryBlock 只 append + 分层 merge，禁止覆盖历史**（设计文档 §31）。

### 9.1 Memory 落地决策（Phase 6）

**D-1 摘要节奏量的是「语音时间」，不是 §31 字面的墙钟**
- 决定：`MemoryCore` 只被 `transcript.final` 推进；当 `(末段 endTime ?? startTime) - 首段 startTime >= SUMMARY_WINDOW_SEC`（默认 240s，落在 §31 的 3–5 分钟）才 flush（env.ts:98、MemoryCore.ts:121）。
- 理由：墙钟定时器会在停讲、暂停、翻页的沉默期继续烧窗口，产出一块**内容为空的摘要**，还会让同一 stretch 被前后两块重复覆盖；摘要的意义在于它概括了多少讲话内容，不是会议开了多久。次要理由是可测性：单测不该真等 4 分钟。
- 被否：`setInterval` 墙钟（§31 的字面实现，上述两个缺陷）；固定段数触发（语速差异让每块长度极不均，快讲者一块 30s、慢讲者一块 3s，"阶段"就不再是阶段）。
- 已接受的代价：讲者长时间沉默时，最后一批内容要等到再次说话或 `recording.stop` 才被摘要 —— 由 stop 路径上的 `flushRemaining()` 兜底，实测尾部单条也会成块。
- 连带结论：`SUMMARY_MIN_SEGMENTS=1`。窗口既然按语音时长凑齐，块内段数就不是触发条件，只是结果；设成 2 会让"整个窗口只讲了一句长话"永远不落地。

**D-2 一个 `parentBlockId` 装不下 n 元合并 → 加法式新增 `sourceBlockIds`**
- 决定：保留 §31 接口里的 `parentBlockId`（合并块指向它的**第一个**子块，作血缘锚点），另加 `sourceBlockIds: string[]` 记录全部子块（types.ts 的 `SummaryBlockSchema`）。
- 理由：`mergeFactor=4` 时一个上层块概括 4 个子块，单值字段在数学上就表达不了；而 §31 的接口是要守的契约，改名会连带震动前后端共享类型与既有断言，所以**只加不换**。
- 被否：`parentIds: string[]`（破坏 §31 字段名）；只存第一个 id（丢血缘，"没覆盖历史"变成不可证明的口头承诺）。
- 判据实现：子块是否还"活着"由 `sourceBlockIds` 集合反推（`unfoldedByLevel` 吸收掉被引用者的 id，剩下的才进该层 pending 队列），不靠 level 或时间猜。

**D-3 阶段摘要失败=前进，合并失败=原地重试**
- 决定：stage flush 抛错 → 发 `module.error{module:"memory", code:"summary_failed"}`，窗口已清空且**不重试、不回填**（MemoryCore.ts:152）；merge 抛错 → 子块**不释放**，`code:"merge_failed"`，下一块落地时同一组再试（MemoryCore.ts:189）。
- 理由：原文永远在 SQLite 里，Phase 7 的检索还能把这段捞回来，所以缺口只损失"概览少一块"，不损失记录；而为一个摘要块死磕会一直占着 single-flight 锁，正是 Test F 禁止的"AI 请求堆积"。合并是纯派生数据，重试无副作用：父块在子块释放的那一步才 `commit`，失败的尝试不落任何行。
- 被否：统一退避重试（同一 prompt 模型答不出第二次，§45 的 1–2 次上限只用于传输层）；失败即回填窗口（同一段话被反复摘要，等于覆盖历史，违 §31）。

**D-4 合并深度与喂给 QA 的概览长度都有上界**
- 决定：`SUMMARY_MAX_LEVEL=2`；QA 侧只取 `globalSummary()` —— 有顶层块时给「整体 mm:ss-mm:ss」+ 其后最近 4 个 level-0 块，否则给最近 4 个块（`MAX_OVERVIEW_BLOCKS=4`）。
- 理由：§31 没给深度上限。2 小时 ≈3000 段 / 240s 窗口 → 约 50–60 个 level-0 → 15 个 level-1 → 4 个 level-2，两级已足够概括整场；不设上限则每来一块都可能触发全链合并，长讲的 LLM 调用次数无界，且"摘要的摘要"迟早要喂回模型 —— 那是 QA prompt 里最不可控、最容易漂移的一部分。
- 被否：无界合并（上述级联 + prompt 膨胀）；每次问答重算全部块（打穿 §3 的 QA 首 token <3s 预算）。
- 附带硬约束：`SqliteSummaryRepository` **只有** `append / list / listLevel / count`，没有 update 也没有 delete —— 不是没写，是写不出：改写一条摘要会静默改掉历史回答的依据。重启时 `start()` 从库里重读已提交块，所以同一 stretch 不会被二次摘要、合并计数不从零开始。

**D-5 Phase 6 零新依赖**
只用已有的 SQLite repository + `LLMProvider` 接口 + emittery，故 `docs/THIRD_PARTY.md` 不新增条目（Rule 4 满足）。**Phase 7 检索落地时必须为 embedding 模型（含权重 License）与向量索引各自补登记**，未登记视为未完成。

### 9.2 检索落地决策（Phase 7）

**D-6 排序仍是暴力 cosine，实测数字给出 ANN 的复评阈值**
- 决定：`embeddings` 表存 float32 BLOB，查询时同库全扫 + `rankByCosine`；不装 `sqlite-vec`，不接 FAISS，不做任何 ANN 结构。
- 实测（本机、`:memory:` 库、25 次取中位数/最大值，`.scratch/bench-scan.ts`；`scan` = SQL 读 + 每行 BLOB 解码，`rank` = 纯点积 + 排序）：

  | dim | 行数 | 向量占用 | scan 中位 | rank 中位 | scan 最大 |
  |---|---|---|---|---|---|
  | 512 | 250 | 0.5 MB | 3.1 ms | 0.5 ms | 9.2 ms |
  | 512 | 1000 | 2.0 MB | 11.3 ms | 2.2 ms | 20.7 ms |
  | 512 | 3000 | 5.9 MB | 33.5 ms | 5.9 ms | 57.7 ms |
  | 512 | 6000 | 11.7 MB | 74.1 ms | 14.5 ms | 123.7 ms |
  | 1024 | 1000 | 3.9 MB | 14.7 ms | 4.4 ms | 33.6 ms |
  | 1024 | 3000 | 11.7 MB | 54.3 ms | 14.1 ms | 86.2 ms |
  | 1024 | 6000 | 23.4 MB | 117.2 ms | 29.1 ms | 259.1 ms |

- 与 Phase 0 侦察数字的**对账**：当时记的"3000×1024 暴力扫 9.4ms/query"是**纯内存点积**，与本次 `rank` 列（14.1ms）同一量级，没有矛盾；差一个数量级的是 `scan` —— 每次查询都重新走 SQL 并把每行 BLOB 复制成 `Float32Array`，这部分是点积的 4 倍。**已知的、暂时接受的浪费**：留一份按 provider+dim 键控的解码缓存能把它砍掉，但那要引入"何时失效"的状态（新行、重嵌、provider 切换），而现在的量级还没到必须为之的地步。
- 怎么读这张表：6000 行 ≈ 两小时讲（10s/段）。中位 ~146ms（scan+rank）对"每分钟问一次"的预算完全够（§3 的 QA 首 token <3s 主要花在 LLM 上），**但它是同步的一段**，期间字幕、partial、心跳全部排队 —— 这正好是 Test F 禁止的 UI 卡顿形状。另注：`:memory:` 是不写盘的乐观情形，真实文件库的 `scan` 只会更慢。所以复评阈值写死在这里：**行数 > 3000，或单次查询 p50 > 100ms**，两者任一成立才允许重新讨论 ANN / 缓存 / 把工作挪出主 loop（Rule 6）；在那之前不预支复杂度。
- 被否：`sqlite-vec`（0.1.9，MIT OR Apache，确实满足 §30 字面的"SQLite + 本地向量扩展"，但要按平台分发可加载原生二进制，而上面的表说明 3000 行还没到需要它的程度）；FAISS（独立 C++ 依赖 + 基本只能走 Python，同时违 §30 的"同库"与 Rule 1 的"不自研/不引重库"）。

**D-7 Mock 向量是「词法下界」，检索质量只能在此之上验证**
- `MockEmbeddingProvider`：CJK 单字 + 相邻双字、拉丁词，FNV-1a 签名进 512 桶，多字 token 权重 1.5，单位化后入库。确定性、零依赖、零网络，因此 §49/§50 的 Mock Mode 能覆盖整条检索链。
- 它明确做不到：把「世界模型」与 "world model" 或"内部预测"判成同义 —— 词法模型没有语义。所以 mock 下的任何 top-K 指标都是**下界**，真实模型只能更好，不能用来反证。
- 实跑证据（`MOCK_STT/MOCK_LLM`，`HOT_CONTEXT_SEC=20`，脚本 8 段讲到 74s）：`indexed=8 dropped=0`，一次查询 `candidates=6 hits=1 topScore=0.609 latencyMs=2`，回答文本含 `[00:20] 这项技术可以应用于机器人和自动驾驶。`，`answer.completed` 的 citations 里有 `{startTime:20}` —— 该行距当时语音时间 54s，**已在热窗口之外**，只可能来自索引。Test D 的机制因此通过；§56 的原话是"他十分钟前是怎么定义这个概念的？"（本条此前引作"约 10 分钟前"，那个"约"是加的，原文没有），而十分钟这个尺度属于 Phase 9 长录里才能构造的东西，e2e 里注释也这样写明。

**D-8 摄取用「有上限的队列」，不是 MindMap 的单飞跳过**
- 理由：MindMap 跳过一批会被下一批的窗口补回来；**丢掉一段嵌入是索引里永久的洞**，而原文还在 SQLite 里 —— 用户永远问不到那一句， yet 表面上系统一切正常。这是最坏的一类静默缺陷，形状与 Phase 1c 抓到的"跨会话主键静默丢数据"相同。
- 因此 `RETRIEVAL_MAX_PENDING=512` 之内一律排队（`EMBED_BATCH_SIZE=16` 攒批），只有真溢出才发一次 `embed_backlog`，并且一次积压只报一个事件 —— 错误风暴本身就是 Test F 要抓的东西。
- 批失败沿用 D-3 的策略：丢弃该批、不重试（`embed_failed`）。重试环会一直占着队列，而那段内容的损失已由"原文 + 热上下文 + 阶段摘要"三层兜住。
- 已知事实：mock 播放速度下几乎每批只装 1 条（实测日志全是 `count:1`），攒批路径**未经压力验证**；真实 provider 上线后（#21）要用长录确认 batching 真发生了。

**D-9 `provider` + `dim` 双过滤：两种向量空间绝不混排**
- `scan(sessionId, ownerType, provider, dim)` 把两个条件都写进 SQL。不同模型产出的 cosine **不是噪声，是自信的错误答案**，一旦混排没有任何下游信号能发现。
- 换 provider 的后果是确定性的：重启后 `start()` 用 `listOwnerIds(...provider)` 预热，发现没有一段属于新 provider → 全量重嵌，靠主键上的 `ON CONFLICT DO UPDATE` 逐行替换旧向量。代价是 N 次模型调用（真实模型上以小时计），**这是有意的**，因为向量是纯派生数据，覆盖是正确语义（与摘要块相反：那里的 repository 根本没有 update）。

**D-10 检索失败只降级回答，绝不影响"还能不能问"**
- `search()` 内部 catch 到底，对外只返回 `[]`；`QaCore` 仍对传入的 search 再包一层 `.catch()`。这第二层存在的唯一理由是 `inFlight` 的加减必须平衡 —— 否则索引一坏，两次未完成的请求就把 QA 永久锁死成"全部拒绝（busy）"。有单测专门锁这条（"still answers, and stays answerable, when the index throws"）。
- 检索发生在快照冻结**之前**，结果进了 `ContextSnapshot` 就不再变（§32）；热上下文里的 id 作为排除集传给索引，所以同一句不会在两个 section 各出现一次 —— e2e 里按 `[mm:ss]` 逐条断言。

**D-11 真实 embedding 模型曾是 Phase 7 唯一未完成项，且当时是"假装可用"**（本条记录 7d 之前的状态与判断标准）
- （当时）`MOCK_EMBEDDING=false` 时 `index.ts` 只 `log.warn("local embedding model not wired yet, using mock vectors")` 然后继续用 mock。**这是未完成标记，不是降级策略** —— 一个没有语义的检索会被使用者当成"这个产品检索不行"，比明确不可用更糟。#21 关闭前不得声称检索质量。
- 未关闭的前置事实（ADR-OPEN-2）：ONNX 推理放主进程还是 `child_process`（约束 3 要求不进主 loop，但 §2 的结论尚未用真实模型验证）。下载渠道已探明：本机 `huggingface.co` 不可达，可用的是 `hf-mirror.com`（实测 200 / 1.16s）与 `modelscope.cn`（实测 302；Phase 0 就是用 `@huggingface/transformers@4.3.1` 的 `env.remoteHost=ModelScope` + `dtype:'q8'` 拉到过 bge-m3 并跑通，**完全不碰 Python**，这条路是候选首选）。
- 侦察期在本机测过的真实模型数字：bge-m3（MIT 权重、1024 维、q8）175 ms/段、3000 段 ≈ 8.8 分钟建完索引、`世界模型 ↔ "World Model"` cosine 0.8728 而无关英文 0.5946 —— 后者正是 D-7 里词法 mock 做不到的跨语言等价。**但这些数字当前无法复核**：权重不在磁盘上（`.probe-model/` 里只剩 STT 模型），所以 #21 必须在仓库内重测一遍才能据此下结论，且 mock 的 0.609 与 bge 的 0.8728 来自不同向量空间、不同查询，**不可横向比较**。
- Rule 4 现状：Phase 7a–7c 零新 npm 依赖（`node:sqlite` + 自有代码），故 `THIRD_PARTY.md` 暂无新条目；**真实模型一旦接入，代码依赖（`@huggingface/transformers`）与权重 License（bge-m3 若选它）两项都要登记，缺一即视为未完成**（D-5 的账仍未付）。已判定不可用的候选：jina-embeddings-v3 是 CC-BY-NC-4.0，商用直接排除。
- *（本条描述的"假装可用"状态已由 D-12/D-13 结束；保留原文是因为它记录的判断标准 —— "没有语义的检索比明确不可用更糟" —— 仍然约束以后任何 provider 降级。）*
- *（7d 复核结果：权重已在仓库内落盘并重测 —— 46–93 ms/段、3000 段 ≈ 2.8 分钟、跨语言 cosine 0.9129；"无法复核"与 Rule 4 的欠账均已清，见 D-13 与 THIRD_PARTY 第 13、14 条。mock 的 0.609 与 bge 的 0.9129 **仍不可横向比较**，这条提醒继续有效。）*

**D-12 推理挪出主 loop，用 `worker_threads` 而不是拆进程**
- 决定：真实 embedding 只在 `retrieval/embeddingWorker.ts`（`worker_threads`）里跑，`OnnxEmbeddingProvider` 只做控制流（串行化、超时、重启、维度校验），`RetrievalCore` 对线程零感知。
- 为什么不是"就在主进程里调用"：同一份负载（12 段 ×4 批，`Xenova/bge-m3` q8）两种摆法各跑一遍，主 loop 用一个 5 ms 心跳 + `monitorEventLoopDelay` 观测：

  | 摆法 | 每批耗时 | 心跳实际次数（应约 848） | gap 中位 | gap p99 | gap 最大 |
  |---|---|---|---|---|---|
  | 线程内（`.scratch/probe-worker-loop.mjs`） | 908–1027 ms | 1268 | 7.2 ms | **30.1 ms** | 144.7 ms |
  | 主 loop 内（`.scratch/probe-inline-loop.mjs`） | 369–440 ms | **11** | 8.0 ms | **1881 ms** | 1881 ms |

  主 loop 摆法每批看着更快（省了跨线程往返），但 4 批期间心跳只响了 11 次 —— **期间字幕、partial、WS 心跳、UI 事件全部排队**。这正是 Test F 明令禁止的形状。
- 为什么不是"独立进程/服务"（Rule 6 要求有证据才拆）：接入后跑了三次真实会话，字幕投递延迟相对每段自己的排定时间戳是基线 2 ms、p95 +3 ms、最大 +4 ms（`metric:embedding_batch` 同时在 46–93 ms 之间稳定产出）。也就是说线程已经彻底消除了侵占，跨进程 IPC 换不来任何东西，只会多一套序列化与生命周期。故仍是**同一 OS 进程内的模块**，Rule 6 未被突破，且这里是有数字的。
- 线程的代价登记在加载上：模型冷加载在线程里是 4.9–5.4 s，而线程外单独加载只要 2.6 s —— 差的是 worker 启动 + `import` 的一次性开销。因此 `index.ts` 在 boot 就 `prewarm()` 且**不 await**，把这笔钱放在无人等待的时刻。
- 线程的失败形状（都有单测锁定，`test/onnxEmbeddingProvider.test.ts`）：请求**串行**（ONNX 已吃满 CPU，并发只会互相拖慢并抢走录制路径的周期）；单批超时 15 s 后放弃该批而不是拖垮队列；迟到的回包按 id 丢弃；`EMBED_DIM` 与模型实际维度不符判为**永久性配置错误**（重试只会死循环），网络/下载类失败判为**可恢复**并在下次请求重生线程 —— 两小时讲话里不能因为一次镜像抖动就永久失去索引。
- **本决策故意没有满足 R4 的原缓解措施**（那里写的是"CPU/原生工作一律 `child_process`，可重启、不连坐"）。`worker_threads` 与主线程共享 V8 堆，onnxruntime 的原生崩溃**会连坐整个进程**，这一层保护确实放弃了。换到的是实测得到的字幕连续性，且残余风险有边界：崩溃只发生在推理路径，而推理路径已由超时/失败降级为"索引不更新"（D-10），原文与摘要不受影响（§14 单一权威源）。已观察样本：三次真实会话、12 批推理、一次 4 批连续压测，无崩溃。**若 Phase 9 长录里真出现原生崩溃，把它挪进 `child_process` 是正确反应，不是背叛本决策** —— D-12 的依据是"当前没有证据需要那一跳的代价"，证据变了结论就变。

**D-13 模型选 `Xenova/bge-m3` q8，`RETRIEVAL_MIN_SCORE` 按实测分布校准到 0.75**
- 选型证据（本机、仓库内磁盘缓存重测，非侦察期数字）：跨语种相关对 bge-m3 **0.9129** vs bge-base-zh-v1.5 **0.6779**；代价登记为体积 560 MB vs 99 MB 与更慢的加载（冷启动 4.9–5.4 s，故 boot 时 `prewarm()`，绝不落在第一个提问上）。权重 MIT，商用干净（第 14 条）。
- **阈值必须重校，不能沿用 mock 的 0.1**：真实会话索引 6 条、三类提问的实测分布是 —— 命中目标句 **0.957**、同主题干扰句 **0.711–0.771**、完全离题最高仅 **0.662**。bge 的绝对分数整体偏高，0.1 在这种向量空间里等于不过滤。取 **0.75**：留住答案句、丢掉离题噪声；`MOCK_EMBEDDING=false` 且阈值 <0.5 时启动即 `log.warn` 给出 0.75 建议。
- 顺带修掉一个会挡住校准的观测缺陷：`retrieval_search` 的 `topScore` 原先取"过滤之后的第一条"，于是阈值杀光时恒报 0，**恰好丢掉最需要看的数**。现在先排序、后过滤，`topScore` 报模型真实给出的最高分。实测两次查询因此可读为 `hits=2 topScore=0.957` 与 `hits=0 topScore=0.662`，后者正是"离题问题不再塞垃圾进上下文"的证据，也是 0.75 这个数能写下来的原因。
- D-8 留下的"攒批路径未经压力验证"仍未解除，且现在有了更硬的理由：真实 provider 单条 46–93 ms，而讲座语速约 10 s/段，**队列永远只装 1 条**（三次真实会话共 12 批全是 `count:1`）。所以 `EMBED_BATCH_SIZE=16` 是溢出保护而非吞吐手段；真要验证 batching 只能靠 Phase 9 的长录，不能假装它被压过。

**D-14 被拦下的 install script 不需要放行**
- 安装时 npm 拦了 `onnxruntime-node@1.30.0`、`protobufjs@7.6.6`、`esbuild@0.28.2` 三个 install script。**没有为了"让它装上"去 `approve-scripts`**，而是先验证：`onnxruntime-node` 的平台二进制随包分发，导入即成功，且三次真实会话全部跑通推理。
- 结论：这三个脚本对本项目是无关路径（CPU 推理 / 纯 JS 协议 / 前端打包器另有预编译），放行只会扩大可执行面。若哪天 `onnxruntime` 的原生后端真的需要安装脚本，那是换 provider 的决策点，不是当场放行的理由。

---

## 10. License 风险登记（设计文档 §9 要求单独标记）

| 组件 | License | 风险等级 | 处置 |
|---|---|---|---|
| elkjs | **EPL-2.0 OR GPL-3.0-or-later** | 🟡 弱著作权 | 仅作**可选懒加载 Worker**；商用前需法务评审；不用则零暴露 |
| new-api | **AGPL-3.0 + 去品牌需商业授权** | 🔴 | **禁用**（当前也不需要网关） |
| GoJS | 商业，≈$3,995/开发者，无 key 带水印 | 🔴 | 排除 |
| tldraw | source-available，**LICENSE 明写禁止生产环境** | 🔴 | 排除 |
| NVIDIA Canary-1b 原始权重 | **CC-BY-NC 4.0 研究专用** | 🔴 | 排除（商用禁止 + 无中文） |
| pyannote 预训练模型 | 代码 MIT 但模型 **HF gated** + 需接受条款 | 🟡 | 延后；本机 HF 不可达 → 实际阻断 |
| `node:sqlite` | 内置（SQLite 公共域 + Node 绿鸿） | 🟢 | 但 **stability 1.2（实验族）** → 封装在单一 repository 模块后 |
| sherpa-onnx 代码+模型 | Apache-2.0 | 🟢 | 商用干净（**本选型的关键优势**） |
| Silero VAD 代码+模型 | MIT | 🟢 | 商用干净 |
| React Flow / Zustand / emittery / Fastify / ws / d3 / Zod / openai-sdk | MIT/ISC/Apache-2.0 | 🟢 | 商用干净 |

**规则**：新增任何第三方依赖必须先写 `THIRD_PARTY.md`（设计文档 Rule 4），未登记 License 视为未完成。

---

## 11. Database Schema（SQLite，设计文档 §40）

```sql
sessions(id PK, title, started_at, ended_at, status CHECK(recording|paused|completed))
transcript_segments(id, session_id FK, text, start_time REAL, end_time REAL,
                    confidence, created_at, PK(session_id,id))
                    -- 只存 final；partial 不落库。时间单位是"会话内秒"（REAL），不是毫秒
                    -- 曾有的 `speaker_id` 已删（§13 OPEN-9）：建表语句里去掉，且 `openSqlite` 会对
                    -- 旧库执行 `DROP COLUMN`——只改 DDL 会让改动之前写下的文件继续带着这一列
                    INDEX(session_id, start_time)
embeddings(owner_type CHECK(transcript|summary), owner_id, session_id FK, provider,
           dim, vec BLOB, created_at, PK(session_id,owner_type,owner_id))
summary_blocks(id, session_id FK, start_time REAL, end_time REAL, summary, key_points JSON,
               entities JSON, level INTEGER, parent_block_id, source_block_ids JSON,
               created_at, PK(session_id,id))
                    -- level + source_block_ids 承载 hierarchical merge（见 §9.1 D-2），append-only：
                    -- repository 无 update/delete 方法，历史摘要在类型层就不可能被改写
mindmap_nodes(id, session_id FK, title, summary, parent_id, confidence,
              source_transcript_ids JSON, created_at, updated_at, PK(session_id,id))
mindmap_edges(id, session_id FK, source, target, relation, PK(session_id,id))
                    -- 只存 add_edge 的横向关联；层级关系不重复入库，它是 parent_id 的投影
graph_positions(session_id, node_id, x, y, pinned, PK(session_id, node_id))   -- 只存用户拖拽，见 §6.1 D-17
graph_operations(op_id PK, session_id, response_id, type, payload JSON,
                 created_at)                                -- append-only 审计+重放
questions(id PK, session_id FK, text, created_at, snapshot_id)   -- 写入在 QaCore 通过准入之后、answer.started 之前
answers(id PK, question_id FK, session_id FK, text, citations JSON, duration_ms,
        degraded INTEGER, created_at)                       -- id = question_id：一问一答，重写同 id 不新增行
```

**`questions` / `answers` 曾是无写入路径的死表**（§13 OPEN-4，Phase 8c 登记）。2026-10-20 补上写入路径：`store/qaRepository.ts` 是唯一的写入者，`QaCore` 在准入通过后写 question（含 `snapshot_id`，使"这个回答是基于哪一份冻结上下文"事后可查），流式结束后写 answer（含 citations / duration_ms / degraded）。三条判定刻意的地方：**被限流拒绝的提问一行都不写**（拒绝没有产生任何内容，写进历史只会让限流看起来像 bug）；**degraded 的回答照样落库**并标 `degraded=1`（用户看到了半截话，历史不该假装没问过）；**会话在模型说话中途结束时也落库**（行是"答过什么"的持久证据，不是发给已离开的客户端的消息）。落库失败只 `log.error`，不改写答案、不发 `module.error`——已经流完的文本不会因为一行没写进去而变成假的。

`graph_positions` 与 `graph_operations` 是超出设计文档的最小新增：前者满足 Test B「重载后图不能跳」——但**只承担用户拖过的那部分**，自动布局不入库（理由见 §6.1 D-17），后者让 AI 生成的操作可审计、可复现、可回放调试（配合 §48 Debug Panel）。

**这一段在 Phase 9 之前是错的**：它按设计文档 §30 的设想写了 `seq / valid / reject_reason` 三列，而代码里的表根本没有——被门控拒绝的操作只进 `mindmap.skipped` 事件和日志，从不落库。soak 脚本照这段文档写 `WHERE valid = 0` 直接报错，才把脱节暴露出来。schema 的唯一真相是 `sqlite.ts` 的 `SCHEMA` 常量，本节只能抄它。同一趟还发现 `mindmap_edges` 有读（`hydrate()`）、有删（`deleteNode`）却没有写，即模型提出的横向关联**活着直到进程重启就永久丢失**；`GraphStore.applyOps` 现在每批把内存态的边整组镜像回表（边集小、内存态为准，比追踪"哪个 op 动了哪条边"更不易错），并有单测锁住"重启后边还在"。

**列后补必须显式迁移**：建表用 `CREATE TABLE IF NOT EXISTS`，对已有行不会加列，所以 `summary_blocks.source_block_ids` 这类后加字段靠 `ensureColumn()`（查 `PRAGMA table_info` 后 `ALTER TABLE`，幂等）补齐（sqlite.ts）。没有这一步，Phase 6 之前的库文件会在第一次 merge 落库时抛 `no such column` —— 而开发机上"永远用新库"的假设正是掩盖这类问题的地方。

---

## 12. 五个最大工程风险

**R1 — 中文准确率 vs 流式延迟 vs 无标点（最高）**
设计文档 §46 给字幕的其实是两档（partial 目标 <1 s、最大可接受 <2 s），它和"中文长句准确"之间本身存在张力；且**本机实测确认流式 CTC 输出没有标点**，这会直接拉低字幕可读性与 MindMap 分段质量。延迟已在两个模型上量化（21 MB 小模型首字 0.73 s；511 MB 双语模型 37 分钟长跑首字 p50 0.936 / p95 1.824 / max 1.974 s——**两档都还在预算内，但距 2 s 上限只剩 26 ms**，见 §6.3 D-24），**质量仍未量化**。
→ 缓解：Phase 5 前必须决定标点恢复策略（ADR-OPEN-1）；用真实演讲音频做双语大模型 A/B；不达标则退到"partial 无标点、final 后补标点"。
✅ **Phase 5 已关闭标点这一半**：策略定为"转写原文不加标点，可读性交给摘要/导图的 LLM 侧"（§6.3 D-22）。延迟也测了（§6.3 D-20：worker 端到端 6–8× 实时；**final 那组 p50 0.95–1.81 s 已被 D-24 推翻为收尾样本**，稳态字幕定稿 ≈ 0.8 s 判停窗口 + 约 0.05 s 处理，而 partial 首字在双语模型上是 p50 0.936 / p95 1.824 s）。**准确率那一半仍未关闭**：实跑语料只有官方自带的 4 段演示 wav（28.7 s 中英混排语法课），既不是真实演讲也不是中文为主的场合；同一份音频在 greedy / beam 下的分段与叠字差异见 §6.3 D-20（那里还记了一条"参数漂移被误读成不可复现"的测量卫生教训）。所以现在**没有可信的中文 WER 数字**——需要真实演讲录音做 A/B，仍未完成。

**R2 — LLM 结构化输出不可靠，Graph 会被写坏**
各家 strict 支持程度不一（DeepSeek 只有 JSON mode；DashScope 上托管的 GLM 有标注"结构化输出 不支持"的实例），即便"厂商 strict"也只是软保证。非法 op 会产出孤儿节点、环、重复节点，从而毁掉 Test B。
→ 缓解：Zod 校验 + `opId` 幂等 + orphan buffer + 环检测 + repair 重试，**这四道闸与 provider 无关，必须存在**；非法 op 一律 discard+log（设计文档 §45）。
✅ **Phase 2 已落地并有真实 wire 证据**：四道闸全部实现在 `shared/src/graph.ts`（见 §7 的两层校验表），gate 单测 + adapter/wire 测试走本地 HTTP/SSE 端点。早期版本的 adapter 只校验 `z.array(z.unknown())`，导致 repair 循环永不触发、非法 op 静默消失——这个缺口已修并回归。
🔶 **"有 key 后逐厂实测"这一半于 2026-10-21 开始还账（§6.5 D-31），量出来的第一条比风险描述本身更严重**：真实模型给每个根节点写 `"parentId": null`，而闸门当时把 `null` 判成非法字符串——**整批拒绝，每一批都拒**，真 provider 一个节点都长不出来。四模型普查确认这是共性不是个案，字段已放宽并配控制组。同一轮还量到：`json_schema` strict 在该端点不可用（所以"厂商 strict"这层保证今天根本拿不到，四道闸是唯一存在的保证）、推理模型会把 `max_tokens` 吃空成 `content:""`。**但"逐厂"这个说法要打折**：量到的几家模型都托管在同一个 DashScope 专属实例上，各家官方端点的行为仍未验证。

**R3 — React Flow 在 Iris Xe 核显上的节点上限未验证**
DOM 自定义节点在数百到上千节点时可能掉帧；社区数字是估算不是基准。Test F 要求 120 分钟不明显卡顿。
→ 缓解：Phase 3 出口条件就是**本机 500/1000 节点 FPS 压测**；降级阶梯为 默认折叠+`onlyRenderVisibleElements` → 迁移 Cytoscape/G6 Canvas（保持 `applyOp` reducer 与坐标模型不变，只换渲染层 —— 这正是把 renderer 视为可替换组件的回报）。
✅ **已于 2026-10-20 用实测关闭**（§6.2 D-26 及其同日更正）：种子路径 `?bench=N` 补上后，在真出画的无头 Edge 155（1440×900、dpr 1、rAF ≈61 Hz）里跑成 500/1000 两档，收尾规模 663 与 1163 节点。**"掉帧"这一维被证否**——缩放/平移/空转共 455 帧，p50/p95/p99 全 17 ms，>50 ms 的帧 0 次；**因此"迁移 Canvas 渲染层"这条阶梯没有实测依据**。但同一批数据在另一个维度亮了红灯：每批 `applyOps` 的同步部分只有 4–13 ms，而 `applyOps→下一次绘制` 是 18–362 ms，生产批次形状下**加一个节点要 14/106/327 ms 才上屏**。⚠️ **我第一时间把这口锅判给了 `buildFlow` 每批新建对象，随后写缓存、复测、撤回——缓存一格都没改善 paint**。实测拆分：本项目全部派生代码只有 4–9 ms/批，CPU profile 折算每批是"浏览器非 JS 工作 ≈231 ms + React 协调 ≈55 ms + React Flow 内部 ≈43 ms + GC ≈30 ms + DOM API ≈18 ms + 我们自己 ≈10 ms"；关掉全部边只降三分之一，开 `onlyRenderVisibleElements` 把 DOM 从 1163 压到 29 个节点反而稳定在 229 ms。**所以现在的诚实状态是：延迟真实存在、原因未知、且不在我们代码里**。既不承诺"改 reducer 能修"，也不承诺"换 Canvas 能修"（Canvas 卖点是少 DOM，而"少 DOM"这一格已被本机实验否掉）。R3 由"节点上限未验证"改写成"**大图下每批上屏要 0.1–0.4 s，归因未完成**"，继续挂在 §13 OPEN-5。

**R4 — 长会话的事件循环抖动与原生模块崩溃**
30–120 分钟里，同步 SQLite 重写入、embedding 推理、未捕获的总线监听器都可能卡住服务 UI 的 WS；原生 addon 在 worker_threads 里 segfault 会连坐主进程。
→ 缓解：`node:sqlite` 写在非音频路径；emittery 隔离 + single-flight + AbortController 超时；Phase 8 做 60 分钟 soak 并把 p95 事件循环延迟记入日志（§47）。**原写法"CPU/原生工作一律 `child_process`"已被 §9.2 D-12 用实测修正**：embedding 落在同进程的 `worker_threads`（消除了 1881 ms 的主 loop 侵占，且不拆服务），代价是原生崩溃仍会连坐 —— 该残余风险连同"何时应改回 `child_process`"一起记在 D-12，不在这里假装已经解决。STT（sherpa-onnx）仍是独立 Python 进程，那一侧的隔离照原样成立。
✅ **Phase 9 给出了 31 分钟的实测**：`loop_delay` p95 全程 16.5→16.7 ms 平直（最差一窗 max 90.8 ms，未转化为字幕延迟），监听器数 30 分钟钉在 35 且两次浏览器重载各自回落后不累积，heap 斜率 0.093 MB/min 与 188 条有意留存数据的量级相符，`module.error` 0 条，stop 后事件计数零增长——"同步 SQLite 重写 + 未捕获监听器把 WS 卡住"这半条风险至此有数可查。**另一半（原生模块崩溃连坐）本场用不上**：全程 `MOCK_EMBEDDING=true`，worker_threads 里的 ONNX 没有参与，所以那部分残余风险仍按 D-12 记着，不因这场长跑而销账。

**R5 — 依赖供应链与网络可达性（本环境特有，极易被忽视）**
本机实测：`npm ping` **PONG 27 秒**；PyPI 安装过程多次 15s 读超时；`huggingface.co` **完全不可达**；`github.com`/`npmjs`/`raw.githubusercontent` 的 curl 需 `--ssl-no-revoke` 才不报 `CRYPT_E_REVOCATION_OFFLINE`；`api.github.com` 匿名限流 60 次/小时；511MB 模型下载**中途断连一次**需断点续传。
→ 缓解：模型改为**一次性手动下载+校验+本地缓存**，不进 CI 关键路径；npm/pip 配置国内镜像并允许长超时；所有依赖版本在 `THIRD_PARTY.md` 钉死；Phase 1 第一件事就是验证 `npm install` 能真的在这台机器上跑完。

---

## 13. ADR-OPEN（Phase 0 未能自行判定，需后续关闭）

| ID | 问题 | 何时关闭 | 默认倾向 | 状态（截至 2026-10-21） |
|---|---|---|---|---|
| **OPEN-1** | 流式 STT 无标点：加标点恢复模型 / 让 LLM 顺带补 / 接受无标点 | Phase 5 接真实音频前 | 接受无标点 + LLM 侧补（零额外模型，成本最低） | **已关闭于 Phase 5**：实测流式 transducer 不出标点，选"转写原文保持原样 + 可读性交给摘要/导图的 LLM 侧"（§6.3 D-22）。`OnlinePunctuation` 在 1.13.8 的 API 里确实存在，若将来要真补，位置是 worker 里 final 之后的一跳，仍然不改 `TranscriptSegment.text` |
| OPEN-2 | embedding 是否必须碰 Python | §9 侦察返回 | 尽量 Node 内解决 | **已关闭：不必碰 Python。**Node 侧 `@huggingface/transformers` + ModelScope 镜像把 bge-m3 q8 跑通过（§9.2 D-11）。留给 #21 的是"要不要挪出主 loop"，那是另一个问题，不再是语言运行时问题（**已答：要，用 `worker_threads`，见 §9.2 D-12 的对照实测**） |
| OPEN-3 | 正式 LLM provider 需用户自提供 API Key | 进入 Phase 4 前 | DashScope（有免费额度） | **已关闭（2026-10-21，§6.5 D-31）**：用户提供了 DashScope 专属实例的 key 与端点，Phase 10 第一次以 `MOCK_LLM=false` 跑通端到端（`qwen3.8-flash`：8 个节点、两题 `degraded=0` 且带真实可点引用、`moduleErrors []`）。关闭的同时抓到三条真缺陷（`parentId:null` 整批拒、推理模型饿死 `content`、分组括号引用不认），全部修掉并各配控制组。key 只写在仓库根 `.env`（不提交、不进文档）。**残留两点不在这条里**：① "逐厂"只量到同一个端点上的托管模型，各家官方端点仍未验证；② 这个 key 已经在对话里出现过，交付前应轮换 |
| **OPEN-4** | `questions` / `answers` 两张表建了但没有任何 INSERT：问答历史只存在于前端内存，刷新即失。是要落库（可回看、可导出）还是从 schema 删掉（少两张没人读的表） | 交付形态定稿前（设计文档只列到 Phase 9，没有"Phase 10"） | 倾向落库。**先记一条本表自己的错**：这一格原先写"设计文档 §34 的'回看提问记录'若保留就必须有写入"，去查 §34——它讲的是 LLM Provider，全文没有"回看提问记录"这句话，也没有任何一节要求跨会话/刷新后回看问答。真正的唯一依据是 §40：它只把 `questions`/`answers` 列进"Schema 至少"的表名清单，即**要求这两张表存在，不要求读回**。所以"落库"满足的是 §40，"要不要读取侧"确实是交付形态的产品决定，不是一条没做完的需求 | **已关闭（2026-10-20）**：选落库。`store/qaRepository.ts` 的 `SqliteQaRepository` 经 `SessionRepositories.qa` 注入 `QaCore`，写入语义见 §11；单测锁住"完成的两行都在且 citations 与事件一致 / degraded=1 也落库 / 被拒绝的提问零行 / 存储写失败不影响已流出的答案"，`qaServer.e2e` 走真实 fastify + WS + SessionRuntime 断言"`answer.completed` 流出去的那段文本与 citations 能在 SQLite 里逐字读回"，死表要再复活必须先把这两处测试一起改掉。负载下的写入另见 §6.3 D-25（12 分钟真实 STT 长跑里边听边问，落库逐条核对）。**未做**：读取侧——`AskAiPanel` 仍只渲染前端内存里的 `answers`（会话内可回看，刷新即空），没有任何接口把这两张表读回去；`sessionStore` 里 `session.snapshot` 的注释就写着"服务器重放转写与图，从不重放答案"。本次只补数据面；"要不要给历史列表加一个 GET、跨 session 怎么选"留给交付形态定稿。 |
| **OPEN-5** | Test F 的"最佳 60–120 分钟"与 R3 的"500/1000 节点"都还没被真正测过：本次跑满的是最低 30 分钟、峰值 188 节点；且连线渲染与 fitView 依赖页面出画，本环境（无原生 viewport）跑不出可信的大图标尺 | 交付前在有窗口的主机上复跑 `.scratch/soak.mjs 60~120`；节点种子路径与基准已就位（见右） | ~~先补种子路径再谈基准~~ → 已补，剩下的那一半只需要时间 | **部分关闭于 2026-10-20**（§6.2 D-26）：**"本环境跑不出大图标尺"这一格已经不成立**——`packages/frontend/src/dev/benchSeed.ts` 提供确定性 `?bench=N`（6 根、深度 ≤4、夹到 2000、5 条单测锁不变量），测量面改用**操作系统已装的 Edge 155 无头实例 + 自写 ~120 行 CDP 客户端跑在已登记的 `ws` 上**（**Rule 4 账目为零：没新增第三方包**；Edge 是测量工具不是产品依赖，版本按 D-20 的教训打进每跑首行日志）。基准在真出画的 1440×900 页面跑成 500/1000 两档：1163 节点下缩放/平移/空转 455 帧 **p50=p95=p99=17 ms、>50 ms 帧 0 次**，边数 1157 与节点数同步，首帧出画 996 ms。**R3 的"掉帧"担忧被证否，"迁移 Canvas"阶梯据此撤销**；换来的真问题是大图下**新节点 14–327 ms 才上屏**（同步部分仅 4–13 ms）。**⚠️ 同日晚些时候我把它归因给 `buildFlow` 每批新建对象、写了节点引用缓存并复测——完全没改善，已撤回**：我们自己的代码只占 4–9 ms/批，profile 里大头是浏览器非 JS 工作（≈231 ms/批），且把 DOM 节点从 1163 压到 29 个（`onlyRenderVisibleElements`）反而稳定在 229 ms，**所以这 200 ms 的归属至今未定**，详见 §6.2 D-26 的同日更正。另测出 `minZoom=0.25` 使 N≥200 后 fitView 永远框不住整棵树（`.scratch/bench-1000-fit.png`），属 §58(d)。**仍未关闭**：① Test F 的 **60–120 分钟**区间——基准是每跑约 2 分钟的图标尺，与时长压测是两个维度，这一半仍照旧要在有窗口的主机复跑 `.scratch/soak.mjs 60~120`（不过 D-26 已经证明"有窗口"不再是必要条件，无头 Edge 就够）；② 真实批次大小（MindMap 每批 1–8 节点）× 图规模的二维表，`grow-by-ONE` 只有 3 个样本；③ 默认折叠 / `onlyRenderVisibleElements` 的实际收益；④ dpr>1 与真机窗口 |
| **OPEN-6** | Test F 只被 Mock 语料证明过：真实 STT 路径的等长长跑（worker 进程 RSS 斜率、30 分钟量级下 partial→final 的 id 单调与去重、断线重连在长跑里的累积行为、浏览器 AudioWorklet 采集在数小时下的稳定性）一次都没跑过；Phase 5 的实跑最长只有 29.8 s | 交付前把 `.scratch/live-real-stt.mjs` 的 wav 源改成循环（或直接接麦克风），在 `MOCK_STT=false` 下复跑 30–60 分钟，采样面沿用 D-19 的 `/api/debug` + `loop_delay`；顺带补一格"双语模型的首个 partial 延迟"（§3 的 0.73s 只有小模型证据） | 不需要新代码——`soak.mjs` 的采样与判定已经写好，缺的只是音频源；先补一条能循环喂 wav 的驱动即可 | **部分关闭于 2026-10-20**（§6.3 D-24）：`.scratch/soak-stt.mjs` 跑了 37.1 分钟真实 STT 长跑（双语模型循环 74 遍 = 2225.1 s 音频，1× 定速、`pacingOverruns=0`）。**已证**：worker RSS 40.7 分钟仅 +2.5 MB（无泄漏斜率）、334 条 final 零重复零倒退零空尾且与库内逐字一致、3626 条 partial 无一入库、`moduleErrors=0`、loop_delay p50 恒在 15.6 ms 的 Windows 定时器粒度上；双语模型首个 partial 延迟已补进 §3，并按 §46 的两档读法给出判定（<2 s 全数达成但只剩 26 ms；<1 s 目标只有半数达成）。**顺带推翻了一条旧结论**：D-20 的"final 迟到 0.95–1.81 s"是收尾样本，稳态处理只有约 30–95 ms。**同日再由 D-25 补掉两格**：12 分钟里杀 5 次 worker，重连的 seq/时钟偏移复合无 off-by-one（id 每轮恰好 +2、零重复零倒退、1122 条 partial 无一入库），并且实测出 warm 停机只有 3.9–4.6 s——**D-21 据以定预算的 19 s 是冷启动，预算对冷启动只剩约 5 s 而不是 5 倍余量**；同一跑每 100 s 提问一题，7 题全部落库可 JOIN、citations 与 snapshot_id 齐、其中 1 题的回答落在 worker 停摆窗口内完成（§44 隔离首次在"真实 STT 故障 + 真实历史写入"同时在场的情况下被证明）。**仍未关闭**：① 浏览器 AudioWorklet 数小时采集（两次跑喂的都是 wav 循环，不是麦克风）；② 中文准确率（重复语料对 WER 无意义）；③ 一次以"驱动侧已喂样本钟"为参照、worker 报端点位置而非当前钟的干净 final 延迟重测；④ **冷启动下的重连**（D-25 全程 warm，19 s 那一档从没在长跑里被接住过）；⑤ `mindmap_edges` 写入仍无真实语料覆盖（两次跑各 107/335 个节点，一条 `add_edge` 都没产生）；⑥ 重连造成的"转写钟落后墙钟"按停机线性累积（12 分钟 5 次 = 30.4 s / 4.2%），而 `[mm:ss]` 引用挂在转写钟上、UI 不说这件事 |
| **OPEN-7** | 重启之后，旧会话的思维导图读不回画面。`GraphStore.hydrate()`（`packages/backend/src/graph/GraphStore.ts:32`）有实现、有单测，但生产里没有任何一条路径用它去恢复旧会话：它唯一的生产调用点在 `SessionRuntime` 构造函数里（`packages/backend/src/runtime/SessionRuntime.ts:103`），而 `RecordingController.start()` 每次都用 `randomUUID()` 开一场新会话（`packages/backend/src/recording/RecordingController.ts:86`）。2026-10-21 实跑（§6.4 D-30）量到的形状：停一场录音后盘上是 1 个 `completed` 会话 + 5 个节点；重启后端，`/api/session` 空闲时回 `sessionId: null, nodes: 0`；再开一场录音，拿到的是新 session、0 个节点。节点在盘上，却回不到屏幕上 | 交付形态定稿前，和 OPEN-4 的读取侧一起定——两件事问的是同一个问题："历史要不要能被读回来" | 要给出承诺才算收，两条路都行：① **接上会话恢复**——先定"用户怎么挑会话、要不要自动续上一场"，再让 `/api/session` 能指名读回某个 session id；② **明确"跨重启不恢复"**——那就把 `hydrate()` 和它的单测改口径为"只服务同一进程内按 session id 重建 store"，并删掉一切恢复味道的说法。倾向 ①，因为它顺带补上 OPEN-4 唯一没做的读取侧 | **已登记（2026-10-21，§6.4 D-30），本轮不实现**：做到的只有两件——把实测写清楚，以及把 `hydrate()` 原文那句 "Rebuild from disk so a restart does not lose the tree"（被实跑证伪）改成带实测边界的说明。没实现 resume，也没有任何测试覆盖"重启后能看到旧会话的图"；不实现的理由是它需要的是会话选择的产品决定，不是一段补丁 |

| **OPEN-8** | 节点摘要从来没有生产者。真实模型普查（4 个模型，`.scratch/llm-null-census.mts`）里 `summary` 出现率 **0**，而原因不在模型：`packages/backend/src/prompts/mindmap.ts` 的 `OUTPUT_INSTRUCTION`（6 条规则 + 一段示例 JSON）**没有一处要求或示例过 `summary`**，模型自然不写。于是 schema 里的 `summary`、`mindmapUserPrompt` 的 `摘要=` 回喂（`prompts/mindmap.ts:31`）、`.mind-node` 的第三行 CSS（`styles.css:322–372`，`NODE_H = 88` 与它同源）三条全是死路径 | 交付形态定稿前：要么在 prompt 里明确要求每节点写一段摘要（代价是每节点多几十 token，回喂也随之变长），要么承认"导图节点只有标题"、删掉回喂与那一行样式 | 倾向**先要求写**——`摘要=` 回喂是模型辨认已有概念的线索，而 D-30 已给过长上限做过截断保护；但"节点该不该带摘要"是产品形态，属 §58(d)，不由我单方面定 | **已登记（2026-10-21，§6.5 D-31），本轮不实现**：证据只有普查出来的 0；改 prompt 会再花一次真实请求，且需要产品判断 |
| **OPEN-9** | `speakerId` 零生产者零读者。`shared/src/types.ts:15` 定义它，`store/transcriptRepository.ts:29` 每行写进去的都是 `segment.speakerId ?? null`，`:86` 读回时再还原——中间没有任何 provider 会填（sherpa 流式识别不做说话人分离，见 §6.3 D-20 的 worker），也没有任何界面或检索读它。D-31 那次真跑的库里 697 行转写，非空 0 行 | 交付形态定稿前，与"要不要区分讲者"一起定：加 diarization 是"再挂一个模型、每一跳延迟"的决定（同 D-22 被否的那条路），不做就应当从 schema 与库里去掉这一列 | 倾向**去掉**。理由与本文件处理 `graph_positions`／`mindmap_edges`／OPEN-4 死表时的口径一致：留着一列没人写的东西，下一次审计会把它当"已有能力"再读一遍 | **已登记（2026-10-21，§6.5 D-31），本轮不实现**：只钉住"零生产零读"这个事实与 697/0 的计数；删列是 schema 变更，不该混进这轮的三处修复 |
| **OPEN-10** | 承 OPEN-7 的决定而来：**单个会话的结构化导出与导入**要做成什么形状。2026-10-21 的探查已把会决定设计的约束钉住：① 所有 repository 的读方法都接受显式 `sessionId`，没有任何一处硬编码"当前会话"（`transcriptRepository.ts:35/45/56/60`、`graphRepository.ts:9/28/105`、`summaryRepository.ts:36`、`embeddingRepository.ts:62/74`）——**"按任意 id 读回"的能力是现成的，缺的只有调用方**；② 但 `qaRepository.ts` 的 `SqliteQaRepository` **只有两个方法且都是写**（`:38/:49`），`questions`/`answers` 零读取路径，导出问答必须先补读取 API（这一条就是 OPEN-4 唯一没做的读取侧）；③ `graph_positions`（`sqlite.ts:86-93`）与 `graph_operations`（`:95-102`）的 `session_id` **没有外键**，且 `graph_operations` 的 PK 是单列 `op_id`（跨会话假定全局唯一）——导入到新 id 时 `parent_id`／`mindmap_edges.source|target`／`summary_blocks.parent_block_id|source_block_ids`／`embeddings.owner_id`／`questions.snapshot_id` 全要手工改写与校验，`ON DELETE CASCADE` 兜不住这两张表；④ `embeddings.vec` 是 **float32 小端 BLOB**（`retrieval/vector.ts:24-26`，默认 `dim` 1024，`scan` 按 `provider AND dim` 双过滤、长度不符静默跳过）；⑤ `questions.snapshot_id` 指向的 `ContextSnapshot`（`qa/contextSnapshot.ts:9`）**从未持久化**；⑥ `/api/session` 只读 `recording.current`、空闲时短路返回空形状（`apiServer.ts:44-59`），WS 的 `graph.snapshot` **只在有 runtime 时才发**（`:144-147`，且位置只发 pinned）；⑦ 前端 `MindMapView` 不假设活跃录音，`useGraphStore.hydrate(nodes, edges, positions)`（`graphStore.ts:62-75`）与 `sessionStore.finals` 就是导入要喂的两个入口，二者都经共享 reducer（`snapshotOperations:99-124`），**不需要伪造 wire frame**；⑧ 后端**没有任何文件写入先例**（`node:fs` 只有三处 `mkdirSync`/`existsSync`），REST 只有 4 条 GET、**没有任何 POST/PUT/DELETE**（变更全走 WS command，`shared/src/protocol.ts:69-89`）——导出端点与导入提交是全新表面 | 实现时逐条定稿格式与身份规则 | 导出＝带 `schemaVersion` 的单会话 JSON、按 session id 命名；**向量不写进文件**，导入时走现有 `RetrievalCore` 重算（"结构化"不该是一堆 base64）；`graph_operations` 不进文件（审计日志而非状态）；导入分配**新 session id** 并记来源，保持 `answers.id == questions.id` 不变量（`qaRepository.ts:56-58`）；导入后的会话**可提问、永久 `completed`、不能再录音** | **已登记（2026-10-21），本轮实现**：`hydrate()`（`GraphStore.ts:32-49`）的口径要一起改——它按 `created_at` 重建兄弟顺序、只恢复 `seenOps` 的 id、完全不碰 positions/summaries/embeddings/QA，本来就不是为"读回一场历史会话"写过的 |

| **OPEN-11** | 安装形态改 `PORT` 之后，页面连的还是 8787。`packages/frontend/src/config.ts:2` 把端口写死进 `API_BASE`/`WS_URL`（host 取 `location.hostname`），而 `RCC.bat` 生成的地址与 `/health` 探针都跟随 `PORT`（环境变量优先、`.env` 次之，`tools/package.mjs` 的 `configuredPort()`）。**现成的出口只有一个且是构建期的**：`config.ts:5` 认 `VITE_API_BASE`，安装形态构建时没有传它，所以运行期没有任何面能让页面包知道真实端口。D-35 当时把"安装形态固定用 8787"作为交付约束记下来并**故意没加配置面**；D-36 的两次安装态验收（缺模块 19/19、加装 13/13）与 launcher 链 8/8 全部用 `PORT=` 覆盖驱动 API/WS，也就是**验的是后端而不是页面里的 JS**，所以"改端口之后页面连不上"这一格至今没有覆盖 | 下一次要动端口配置时（企业环境换端口、同机两套实例）——那时顺带做浏览器级验证 | 让 `config.ts` 跟随 `location.origin`（D-35 原话给的就是这条姿势），WS 用同一 origin 换 scheme；不做安装包里的端口写入，也不做"构建时把端口烧进包里"——那条只在打包机上知道端口，装到别的机器依旧错位 | **已登记（2026-10-22，§6.5 D-36），本轮不实现**：默认 8787 的交付形态是覆盖过的（launcher 链 8/8 里含"页面由装出来的应用伺服"），这条只影响"用户自行改 `PORT`"的路径，改它要一并重跑页面级探针 |

**§13 补记（2026-10-21 的四条交付形态决定，由用户当面选择；上面各行正文保持写入当时的状态，不回改）**

- **OPEN-5 的时长那一格：关闭**。60.05 分钟跑满（D-32），§53 的"最好 60～120 分钟"区间下限达成。**其余三格（真实批次×图规模二维表、折叠/`onlyRenderVisibleElements` 的实际收益、dpr>1 与真机窗口）不在本轮承诺之内**——用户明确选择"只跑不需要人参与的复跑，然后定稿"，而这三格需要的是新的测量工具而不是时间。那个 200 ms 上屏延迟归因未定仍照 D-26 挂着。
- **OPEN-6：按决定收口**。剩下的 ①浏览器 AudioWorklet 数小时采集、②中文准确率，**必须有真人对着麦克风说话**，不属于"不需要人参与的复跑"，因此**本轮不关闭**，如实交付为未覆盖。③final 延迟的干净重测、④冷启动重连、⑤`mindmap_edges` 的真实语料覆盖，都不需要人，但需要新写驱动——已登记，不在本轮范围内粉饰。
- **OPEN-7：不采纳原拟的"服务端会话列表 + 自动续场"，改为"单个会话的结构化导出与导入"**（用户原话：「我希望是能支持单个会话的结构化导入和导出」），并把导入后的深度定为**可提问的历史会话**——图、字幕、摘要、问答全部回屏且能在它上面检索提问，但这场永久 `completed`、不能再录音。这条决定同时把 OPEN-4 唯一没做的读取侧变成导出文件的一部分。实现边界另立新格 **OPEN-10**，因为探查已发现若干会决定形状的约束。**→ 已落地（2026-10-21，§6.5 D-34）**：那八条约束逐条对账的结果是——① 现成的"按任意 id 读回"够用，没有为导出新增任何 repository 读方法，只补了 QA 的 `listExchanges`（OPEN-4 读取侧随之关闭）；③ 的"全要手工改写"被**收窄成只有 `questions.id` 一列**，因为其余四张表都是 `(session_id, …)` 复合键、重打即自洽；④ 向量不进文件、导入时重算；⑤ `snapshot_id` 原样带过去（`ContextSnapshot` 至今仍未持久化，导出的是它的 id 而不是它的内容）；⑥ `/api/session` 与 WS 快照零改动，靠的是把查看态塞进 `recording.current` 这一个槽位；⑦ 前端确实不需要伪造 wire frame，但走的是既有的重连路（`resyncFromServer()`）而不是直接喂 store；⑧ 全新表面＝三条路由 + 手写 preflight + 32 MB `bodyLimit`。`hydrate()` 的语义一行没改，但**不要读成"历史与它无关"**：导入先把行写进库，`openHistory()` 再按这个新 id 构造 runtime，而构造函数里的 `hydrate()`（`SessionRuntime.ts:103`）就是历史导图的装载器——这条新路是"导入 + 既有装载器"，不是另写一套水合。它的口径注释（`GraphStore.ts:25-31`）本轮按实测改写过：原文"Resuming a finished session is not wired"在 D-34 之后就不成立了，现在写明两个调用方的差别正是 OPEN-7 的全部内容（`start()` 永远新 id ⇒ 旧行仍回不来；`openHistory()` 用刚导入的 id ⇒ 回得来），并且仍然没有任何"列出/挑选会话"的东西。
- **OPEN-8：要摘要**。改 `prompts/mindmap.ts` 的 `OUTPUT_INSTRUCTION` 明确要求模型每节点写一段摘要，代价（每节点多几十 token、回喂变长）已计入；**改完必须发一次真实请求验证模型真会写**，按成本纪律用最便宜那一档、一次即够（同 D-31 那条纠正）。`.mind-node` 第三行的 `NODE_H` 与它同源，改的是渲染几何，需按 §8 的实测行高复核。**→ 已落地（2026-10-21，§6.5 D-33）**：prompt 第 5 条 + 示例 JSON + Mock 生产者 + 闸门放宽（空摘要不得毁整批，判别测试实测先红后绿），一发真实请求证到 `qwen3.8-flash` 会逐节点写摘要；`NODE_H` 复核的结论是**不需要改**——第一版探针报的"贴边"是尺子错算（React Flow 视口 `scale` 与布局像素混用），修正后最坏情况元信息距裁切边 6.5px，一次据此做出的 CSS 改动已撤销。
- **OPEN-9：删掉 `speakerId`**。零生产者零读者（真跑库里 697 行非空 0），口径与本文件处理死表一致：留着一列没人写的东西，下次审计会把它当"已有能力"再读一遍。删的是 `shared/src/types.ts:15` 的字段、`transcriptRepository.ts:29/86` 的写与读，以及 §11 的 `speaker_id` 列。
- **key 卫生**：那个已在对话里出现过的 DashScope key，**用户 2026-10-22 决定不轮换，改为开发结束后在控制台停用**（原话：「不做轮换，开发结束后我会停用这个key」）。它从未进入 `docs/`、本文件或 `THIRD_PARTY.md`，只存在于仓库根 `.env`；2026-10-21 用 key 原文在全仓搜过一遍，命中只有 `.env` 一处，`.gitignore` 也早已排除它。这条决定有一层必须一起写下来的含义：**停用之前这把 key 一直是有效的**，所以这份代码在开发结束之前不应交到别人手上、也不应挪到局域网或公网——这与 D-34 登记的"`access-control-allow-origin: *`、无鉴权、只听 loopback"是同一条约束的两端。停手动作属于用户，不由任何一轮实现代劳。

**注**：这一条曾是全表唯一需要用户介入的门槛——OPEN-3 属设计文档 §58 列出的"必须提供 API Key"情形。key 已于 2026-10-21 由用户给出并关闭（§6.5 D-31），所以**现在表里没有一条是"等外部输入"的**：OPEN-4 的读取侧、OPEN-5 的时长复跑、OPEN-6 的麦克风与中文准确率、OPEN-7 的会话恢复、OPEN-8 的摘要、OPEN-9 的讲者列，全部等同一条交付形态决定或一次不需要 key 的复跑。**这些决定已于同日给出，逐条见上面的「§13 补记」**；补记不改动上面各行的正文，因为那些正文记录的是"当时判到哪一步"，改成事后口径会让这张表失去审计价值。

---

## 14. §56 验收对照（逐字判据 × 证据锚点 × 未覆盖的那一半）

设计文档 §56 的六条是这个项目唯一的"跑什么才算好"规范。本节把每条的**字面原文**、**证据落点**、**判到了哪一步**、**还差的那一半**放在一起，目的是防止以后拿相邻维度的数字顶替某一条。判据原文于 2026-10-21 从转录逐字取回（仓库里没有规范副本，见项目记忆「Governing design doc」）。

| 判据（逐字） | 证据锚点 | 判到了哪一步 | 未覆盖的那一半 |
|---|---|---|---|
| **Test A** 讲话：`人工智能正在从大型语言模型逐渐扩展到世界模型。`／字幕：**2 秒内出现。** | `.scratch/test-a-subtitle.mjs` + `.scratch/test-a-result.json` + `.scratch/test-a-page.png`（D-32） | **已在真出画的页面上判定**：目标句距排定时刻 26 ms，UI 自身开销 11 ms，半句早 2.990 s 上屏，截图肉眼核对。这是本条第一次有页面级记录 | 参照钟是 Mock 的**排定时刻**，不是声波到达麦克风的时刻；真实语音下的"2 秒内"属 OPEN-6，至今没有任何页面级测试 |
| **Test B** 「讲话约 30 秒」，出现 `Artificial Intelligence` └── `World Model`，「更新过程中整个图**不能频繁重排**」 | `packages/frontend/test/layout.test.ts:6`（"The invariant Test B is really about"）、§8「MindMap 渲染与布局」里"锚点语义的实跑证据"那条、§6.1 D-17 的实跑、`packages/backend/test/reconnect.e2e.test.ts:22` | **"不频繁重排"这半句有断言且实跑一致**：顶层树锚点单调、拖走的节点重载后停在原处、其子树整体平移 236 px、未触碰的树仍 `x=0`（D-17 因此把布局持久化边界钉成"只存 pinned"） | 文档例子树是**英文标题**，与中文优先的产品取向有张力；"约 30 秒内出现这两个具名节点"这半句只在 Mock 语料上间接满足（`MOCK_SCRIPT[3]` 正是那句话），没有人按英文标题做过结构比对 |
| **Test C** 录音过程中问「世界模型和语言模型有什么区别？」，必须「录音继续 / STT 继续 / MindMap 继续 / QA 回答」 | `packages/backend/test/qaServer.e2e.test.ts:92`（标题已改为 …while the recording keeps producing finals (Test C)） | **四条都有断言**：答案流出可解码 + `transcript.final` 恰为 `MOCK_SCRIPT.length`（一条不少）+ `mindmap.updated > 0`（导图在同一会话里长过）+ 录音状态正常 | **严格同时性给不出**：这里的 mock 以 `mockSttSpeed: 500` 在 ~158 ms 内放完 79 s 脚本，"继续"只能读成"完整"而非"与答案重叠"；真正边听边问的重叠证据来自 D-25（12 分钟真实 STT，7 题全落库、1 题落在 worker 停摆窗口内完成）与 D-31 的真模型跑 |
| **Test D** 问「他十分钟前是怎么定义这个概念的？」，系统**可从历史 Transcript 检索答案** | `packages/backend/test/pipeline.e2e.test.ts:177`（`:223` 直接断言 prompt 里"### 检索到的历史转写"那一段） | 有一条离开 Hot Context 的旧行**经索引被引回**并成可点引用；`RETRIEVAL_MIN_SCORE` 按实测分布校准（D-13） | "十分钟"是相对真实时钟的语义，测试用的是脚本偏移；中文"这个概念"的指代消解没有任何测试——检索靠词法与向量相似，不靠指代 |
| **Test E** 任意关闭 MindMap Agent → STT 仍工作；关闭 QA → MindMap 仍工作（**两个方向**） | `packages/backend/test/faultIsolation.e2e.test.ts:59`（只 QA 坏）与 `:153`（全场故障风暴）、`packages/backend/test/pipeline.e2e.test.ts:68` | 两个方向都有断言：QA 全坏时导图与节点照常长（`batches.length > 0`、节点 > 0）；模型全坏时字幕一条不少（`listFinal === MOCK_SCRIPT.length`）且 `mindmapCalls === requested`（重试纪律，不热循环）、`module.error` 只来自 mindmap/memory、stop 后事件计数零增长 | 关闭的是**provider 层**（注入坏依赖），不是进程级 kill；进程级重启/崩溃恢复那一半属 OPEN-7/OPEN-10，已由 D-34 用导入导出来回答，且 D-34 的 `live-restart-import.mjs` 是**真 kill 再换一个进程指向同一个库**跑的 |
| **Test F** 运行**至少：30 分钟**；没有：严重内存泄漏 / Transcript 丢失 / MindMap 大量重复 / UI 明显卡顿 / AI 请求不断堆积（**五条**） | D-19（31 分钟，含浏览器）+ **D-32（60.05 分钟，§53 的 60–120 最佳区间）**：`.scratch/soak60-analysis.txt`、`.scratch/soak-out.json`、`.scratch/rcc-soak60.sqlite` | **五里四有数**：泄漏斜率 0.08 MB/min 且与 365 条留存数据成量、`listeners` 恒 19；`365 = 365 = 365 = 365`、`dropped 0`、悬空父 0、`dupAddNodeIds []`；`mindmapRequests` 2.38 次/分（恰为上界）、`pending ≤ 3`、`answersInFlight 0`；字幕 max 间隙 13 013 ms；`moduleErrors 0` | **「UI 明显卡顿」这半句两场都没有证据**（两场分别用无浏览器 / 无长跑浏览器）。帧率数字属 D-26 的 1163 节点基准，是**另一场测量**，不能顶进这一格。另外：60 分钟是**自设加强目标达成**，规范字面底线是 30 分钟；真实 STT 的等长长跑最长仍只有 37.1 分钟（D-24） |

**读这张表的三条纪律**
1. **一格只有一个测量面。** Test A 要 DOM、Test F 的卡顿那一半要帧率，都不许用线级或计数顶替——这正是本表存在的原因。
2. **"有断言"不等于"覆盖了字面"。** 每一行的右列都是必须一起读的部分，尤其 Test C 的"同时性"与 Test B 的英文标题。
3. **自设目标不能写成规范要求。** 60–120 分钟来自 §53，§56 的字面只有"至少 30 分钟"；把前者说成后者会让验收标准悄悄变严，反过来也会让人以为"没到 60 就是不合格"。

## 15. Windows 桌面运行基础（2026-10-22）

本节是当前桌面入口的补充决策；历史阶段的浏览器启动器、数据路径与测量结论不被覆盖。结构与操作见 [DESKTOP.md](DESKTOP.md)，本轮证据见 [DESKTOP_VALIDATION.md](DESKTOP_VALIDATION.md)。

- **桌面方案**：采用 Electron 45，加载真实 `packages/frontend` 构建页面；不接入 `design/meeting-workbench` 的示例数据，不为桌面重写后端或数据库。
- **运行时分离**：后端作为配套官方 Node 26.7.0 的独立子进程。实测 Electron 内置 Node 24.22.0 也支持 SQLite 探针，但这不足以证明整套后端和后续原生 embedding 依赖兼容；保留独立 Node 可沿用当前测试与生产依赖闭包。代价是安装体积增加。
- **实例与就绪**：Electron OS 单实例锁先于后台创建；独立数据目录区分开发/预览/测试。后端绑定 `127.0.0.1:0`，通过私有 IPC 返回随机实例 ID、PID 和实际地址，再做带私有访问头的健康校验。既有 8787 服务不参与探测或接管。
- **退出**：关窗等于退出，无托盘。录音/暂停/待授权先提示；前端停止采集并断开连接，导航到退出页销毁采集文档，后端通过 IPC 排空录音、关闭服务和 SQLite。超时只终止所持有的子进程；父进程丢失由 IPC disconnect 触发后台清理。日志使用直接文件句柄，避免父进程崩溃后的 EPIPE 妨碍清理。
- **边界**：Node/shell 不暴露给页面；sandbox/contextIsolation/webSecurity 开启，只允许固定本地内容。导航、新窗口与外部网络受限；麦克风需明确许可，相机/屏幕拒绝。AudioWorklet 改用 Vite `?url&no-inline` 的同源脚本，保留 `script-src 'self'`，没有关闭安全机制。
- **数据**：程序目录与独立用户目录分离，首次只复制缺失配置；桌面不读取源码/旧版配置或数据库，不做自动迁移。核心包不含真实模型、Python、真实 embedding 运行时、会议数据或密钥；桌面不隐式下载模型。
- **复核后保留的限制**：桌面私有访问控制不关闭浏览器入口 I07；录音竞态 I02、恢复 I03/I04、补建/断线缺口 I05/I06 等仍待解决。虚拟文件上传只证明传输，不是硬件麦克风或真实 STT 验收。

方案依据：[Electron 安全建议](https://www.electronjs.org/docs/latest/tutorial/security)、[Electron 进程模型](https://www.electronjs.org/docs/latest/tutorial/process-model)、[Vite 静态资源](https://vite.dev/guide/assets)。最终结论以本项目的实际进程、安装与音频验证为准。

## 16. M1 录音、配置与浏览器访问（2026-10-22）

本轮是在第 15 节桌面基础上继续修复业务运行问题，版本为 `0.1.0-desktop-preview.2`。当前验证见 [M1_VALIDATION.md](M1_VALIDATION.md)，未完成部分仍按开发计划管理。

- **生命周期**：Controller 排队串行处理开始/结束；取消握手不排在握手后等待。SessionRuntime 在 connect 前持有 provider，并以会话代次/AbortSignal 隔离迟到事件；取消后清理旧连接，不让异步续体重启订阅。正常已就绪的识别器仍先 flush 尾句，再排空导图/摘要/检索，避免为修竞态丢失最后一句。
- **暂停**：模拟 provider 保存每个待触发任务的剩余时间，暂停冻结、继续重新排程；真实输入暂停仍通过释放设备和后端输入门控完成。允许识别器完成暂停前已收到的尾部音频；断线缺口和时间轴修复仍属于 I06。
- **采集准备**：真实麦克风在请求设备前检查 worker ready 协议，默认模拟配置明确拒绝。Python worker 只支持一个录音连接，继续时检查已有连接，不再开一条探针连接。初次探测先关闭自身 WS，再返回结果；探测无音频与识别请求，不代表模型效果验收。前端准备可取消，迟到授权与初始化失败均释放设备。
- **配置**：`.env` 与进程变量合并但不污染全局环境，进程变量优先。严格检查布尔、整数、有限范围、16 kHz 与回环地址；请求真实 LLM 却缺密钥即失败，不改变请求的 provider。模式展示区分配置与依赖文件可用性，文件存在不等于推理已成功。
- **浏览器入口**：精确回环 Host/本应用或固定 Vite Origin，替代宽泛 CORS。端口专属 HttpOnly/SameSite=Strict cookie 由受控本地引导设置；数据 HTTP/WS 共用凭证，重连重新引导，处理后台重启的令牌变化。公开 health 只给最小身份和存活，不提供会话/配置。保留桌面随机私有访问头，页面仍拿不到任意 Node 执行能力。
- **范围限制**：这是新源码的本地浏览器访问约束，不是账号系统、同用户本地进程隔离或完整安全审计。旧安装版和旧浏览器启动器未更新；I03/I04、I05/I06、工作台接入不在本轮修复范围。真实硬件与模型尚缺，M1 不标为全部完成。

## 17. M2 会话复习与选择恢复（2026-10-23）

- **结束与关闭分开**：页面 `recording.stop` 调用 `finish()`，先门控输入、排空尾音与派生队列，再保留同一 QA/近期原文与索引。保留期间不重启输入和导图代理，正在回答的问题可以完成。显式 `session.close` 释放运行时、清除选择并广播空快照；进程退出仍使用原完整 `stop()` 清理，并保留重启选择。
- **持久化最小元数据**：在同一 SQLite 增加单行 `workspace_state` 保存选中 ID，以及可空 `sessions.duration_sec` 保存不计暂停的采集时长。老表只做幂等增量，不自动复制旧安装数据，不给老记录补造时长。重启只打开所选会议供查看；未正常结束的记录状态保持原样，页面明确提示，不自动续录。
- **恢复边界**：SessionRuntime 构造时 prime 已保存 final，不重发事件或启动补建。Memory/检索读取已有数据，索引失败仍有近期原文；超窗内容和派生缺失留给 M3。按 ID 打开/导入拒绝覆盖活跃录音；慢导入校验选择版本，不抢回较新的选择。
- **一致替换**：首次连接与选择切换使用同一组会议/图/原文/问答快照。新答案 token 和会话级错误带 ID，前端过滤旧事件；切换重置图位置/折叠等缓存，同会话重连保持锚点。新问题带目标会议 ID，防止切换竞态把旧问题交给新会议。保持原浏览器/桌面安全边界，不扩大为多用户或多会议并行能力。
- **验证**：正式测试新增 14 项，共 335 项通过；包含旧 SQLite 数据保留、故障索引上下文、慢导入选择竞态、双窗口重连与旧内容隔离。实际桌面和安装记录入口见 [M2_VALIDATION.md](M2_VALIDATION.md)。硬件麦克风与真实模型效果仍独立验收。
