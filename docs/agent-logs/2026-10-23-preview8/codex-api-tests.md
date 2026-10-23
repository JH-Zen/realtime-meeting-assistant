# 导图补建 API 集成测试与独立审查 · Codex 接口测试 agent

- 作者 / agent ID：`/root/index_api_tests`。
- 执行工具与模型：Codex 子 agent，通过 PowerShell 与文件补丁工具工作；本会话未独立确认更具体的模型标识，未调用其他模型。
- 日期与对应软件版本：2026-10-23，`0.1.0-desktop-preview.8`。
- 记录类型：实时记录。
- 状态：已完成本 agent 的独立 API 测试与只读审查，最终 11/11 通过；生产修正、Qoder 集成、全量回归和发布验收由主 agent 负责。

## 任务与写入范围

负责为本轮显式导图补建新增 8 至 10 项真实 API 集成测试，并对主 agent 的生产接入做只读对抗性审查。覆盖只读状态、显式补建、并发合并、原文进度账本、旧导图确认、录音互斥、会话切换、失败与停止边界。

允许写入的文件只有：

- `packages/backend/test/mindmapRecoveryApi.test.ts`（新增）。
- `docs/agent-logs/2026-10-23-preview8/codex-api-tests.md`（本记录）。

不修改生产文件、协作索引、软件版本或其他 agent 的记录；保留接手时已有的全部未提交改动。工作区为 `D:\AI Workspace\Codex Workspace\实时会议助手`，不把整个仓库的脏 diff 归为本 agent。

## 实际改动

| 文件 | 自己实际实施的改动 | 行为与原因 |
| --- | --- | --- |
| `docs/agent-logs/2026-10-23-preview8/codex-api-tests.md` | 开工建立进行中记录，完成时补充结果与风险归属 | 保留实际贡献、执行证据和待交接边界 |
| `packages/backend/test/mindmapRecoveryApi.test.ts` | 新增 11 项真实 API 集成测试，最终全部通过 | 使用真实 SQLite / SessionRuntime / RecordingController / MindMapAgent / GraphStore / API 路由，覆盖接口和故障隔离 |

未编写或修改任何生产实现，没有回退、清理或认领其他 agent 的脏改动。验证时构建 shared 会更新对应构建产物，这是仓库要求的前置步骤，不是本 agent 编写的业务代码。

### 11 项测试的实际覆盖

1. 打开保存的历史会议、反复读取 recovery 状态，不调用 embedding 或 LLM，不改变节点、进度账本和原文。
2. 显式 POST 返回 202，生成节点与进度同批持久化；关闭再打开会话运行时后仍可读到已处理段落，再补建完整历史不重复调用模型，原文不变。
3. 模拟实时导图失败后结束录音，在保留的 viewing runtime 上继续显式补建；合法空 operations 也写入进度，节点仍为空，重新打开会话后账本仍存在。这不是内容覆盖或提取质量证明。
4. 受控持有模型响应，连续 6 次 POST 合并为同一任务；busy 可读、模型最大并发为 1、各原文段只被处理一次。
5. 无当前会议、错误会议 ID 的 GET / POST 返回 409 session_changed，不调用模型、不暴露其他会议状态、不跨会议记账。
6. GET 可只读录音状态；POST 在 recording、paused 以及 viewing 但 queued transition=true 时均拒绝。过渡场景通过真实 closeSession 排队建立，没有伪造控制器 getter。
7. 旧导图有节点但无账本时，GET 显示 legacyUntracked；allowUntracked 非布尔类型返回 400，缺少确认或 false 返回 409 untracked_graph，明确 true 才启动。用合法空 ops 验证已有节点保持原样、进度可以建立。
8. 持续模型失败后保留 missing 和 lastError，不写节点或进度；GET 不自动重试。用假时钟推进退避，无真实长时间等待。
9. 分别验证旧会议的迟到成功响应与迟到失败：切到另一会议后不写旧图、不跨会话记账、不发布旧会议错误；新会议仍须自己显式启动。两会议使用重复 segment ID 检验复合会话边界。
10. 对真实 graph repository 的账本写方法注入持续异常，验证 SQLite 事务回滚节点、操作记录与账本，内存图和节点事件也不越过失败提交；恢复写入后下一次显式补建成功。

11. 追加回归（2026-10-23，主 agent 明确要求）：分别验证全非法和合法/非法混合 live 响应不冒充 processed；混合响应的合法节点仍保留，原 wire 不新增 module.error；incomplete_batch 审计存在；随后补建必须明确 allowUntracked，同意后合法空 ops 写入成功账本并使风险状态清除，原审计不删除。两个分支均已通过。

模型替身只实现受控合法结构化返回、延迟与异常，仍通过真实 schema / parseGraphOperations / GraphStore / SQLite 事务。没有用空壳 MindMapAgent、GraphStore 或 API 替代实际链路。

## 协作与归属

- 主 agent 负责生产核心、HTTP 接口和 UI 接入。
- Qoder 通过用户可见 CMD 在独立副本中负责核心测试。
- 本 agent 负责独立 API 测试和只读审查，不再委派任务。
- 主 agent 实施了 MindMapAgent、进度账本表与 repository、GraphStore、API、SessionRuntime / RecordingController 和 UI 的接入；本 agent 只读取和测试，没有将这些实现归为自己。
- 本 agent 提醒刚结束录音的 retained runtime 不应因 mindmap.stop() 而使补建静默无效。主 agent 将保留会话时的停止改成 pauseLive，dispose 仍 stop；该改动由主 agent 编写，本 agent 的第 3 项测试实际验证通过。
- Qoder 的核心测试由其自身与主 agent 执行和集成；本 agent 未执行 Qoder CLI，也未采用或修改其测试草稿。

## 实际验证

| 执行方 | 检查 / 命令 / 证据 | 结果及证明范围 |
| --- | --- | --- |
| 本 agent | 阅读根 `AGENTS.md`、`docs/agent-logs/README.md` 与 `TEMPLATE.md` | 已完成，确认文件责任、记录及先构建 shared 的要求 |
| 本 agent | `npm run build -w @rcc/shared` | 通过；在本轮 API 测试前执行 |
| 本 agent | `npm test -- packages/backend/test/mindmapRecoveryApi.test.ts` | 原 10 项首次通过，611ms；回调整理后 10/10，586ms；追加第 11 项及测试参数修正后最终 11/11，575ms |
| 本 agent | `npm exec --offline -- biome lint packages/backend/test/mindmapRecoveryApi.test.ts` | 最终通过，只检查该文件，无自动修改 |
| 主 agent，按其会话消息转述 | 针对性 24/24、原全套 373 项、开发桌面 40 检查、浏览器 7 检查 | 主 agent 报告通过；本 agent 未亲自执行或复核，不计入自己的验证贡献 |
| 主 agent，按其后续消息转述 | 修正后的原 34 项相关测试、Qoder 16 项核心测试 | 主 agent 报告通过；并行全套曾 399/400，唯一失败为本 agent 新测试漏传 limit。本 agent 修正并验证单文件后，由主 agent 再跑全套；最终全量结果不在本 agent 亲跑范围 |
| 主 agent，按最终消息转述 | 最新全套 50 文件 / 400 测试、typecheck、lint | 主 agent 报告通过，lint 保留 12 warnings + 1 info；本 agent 未亲自运行这组全量检查，不认领其验证 |

原 10 项首次运行时生产接口已可用，10 项直接通过。追加第 11 项首次运行时出现 1 项测试自身错误：调用 SqliteGraphRepository.recentOperations 漏传必需的 limit，SQLite 无法绑定 undefined。本 agent 在自己的测试中把两处调用补为 recentOperations(id, 20)，随后亲自复跑 11/11 及离线 lint 通过；没有为规避错误改生产代码。主 agent 的并行全量运行也碰到此测试错误，该运行属于主 agent。

测试前的小范围静态检查还发现测试总线标签需使用 ModuleId，已在自己的新文件中修正；无生产修复归为自己。

### 独立对抗性审查反馈

本 agent 已通过本会话消息向主 agent 反馈以下具体风险，未修改产品源码：

- **实时语义拒绝与账本保守性**：审查时 generateBatch 在 strict=false 的 live 路径中，即使 parsed.rejected 非空或 accepted 为空，仍将整批 segment ID 传给 applyOps 并标为已处理。全批非法响应因此可能显示 missing=0，显式补建入口无法再处理。建议保持既有 wire 的“合法操作保留、不新增 module.error”行为，但有语义拒绝时不确认整批进度，或另外表示部分/失败状态。此建议针对进度资格，不要求把 live 改成严格整批拒绝。
- **实时部分提交兼容性**：审查时 GraphStore 仅因 processedSegmentIds 非空便对新的 reducer skipped 整批抛错；live 同样传入全批 ID。批内相互影响的 move 等操作可能在旧图上各自通过 parse，顺序应用时才被 reducer 拒绝，导致合法 live 操作也回滚。建议区分显式补建的严格原子性与旧实时路径的部分提交策略。
- **停止与超时的实际边界**：epoch / closed 守卫覆盖补建落地、失败和重试边界；stop 可唤醒退避。LLMProvider 没有 AbortSignal，停止不会中止正在进行的模型网络请求；OpenAI structuredGenerate 内部最多 2 次 HTTP 尝试，叠加外层补建 3 次时最坏每批可达 6 次 HTTP。接口测试没有验证真实网络超时；不能将防迟到写表述为已经中止模型请求。
- **并发边界**：公开 POST 只在 viewing 可用，正常录音期间无法由该接口启动补建。核心补建等待 live busy，成功提交后会从 buffer 去掉相同 ID，常见排队重复受到保护；极端核心级交错仍应结合 Qoder 的独立核心测试核对，本 agent 的模型持有用例验证的是公开 API 路径。

API 的当前会话检查、录音/过渡互斥、legacy 确认及 body 校验顺序，未发现新的阻断问题。UI 使用显式提示与明确的旧图补建按钮，并沿用作用域 cleanup、AbortController、响应序号隔离旧会话结果。导出暂不带账本、再导入按未知进度处理，是保守处理；本 agent 没有将其视作可恢复的历史处理证明。

### 2026-10-23 后续：主 agent 采纳风险并要求追加回归

主 agent 在会话消息中确认采纳上述风险，保留 live 部分提交与原断言，并以 graph_operations 的 incomplete_batch 段 ID 标记未完成处理；GraphStore 增加仅 live 使用的可选第 4 参数，第三参数保持严格 checkpoint 约定。legacyUntracked 包含未成功的 incomplete 标记，成功补建按账本清除风险而不删除审计。这些生产修正由主 agent 编写，本 agent 只追加第 11 项独立回归与本记录。

收到接入通知后，本 agent 再次先构建 shared，并在修正自己的测试参数错误后验证 11/11 通过。最终只读核对确认 strict checkpoint 与 live 第 4 参数分开、incomplete 审计写入与 hasUntrackedChanges 已接入；不将这些生产修正认领为自己编写。

主 agent 也确认文档将区分 3 次逻辑尝试、adapter 每次最多 2 次 HTTP（合计最多 6 次），以及停止只取消退避并阻止写入或旧错误，不 abort LLM 的在途 HTTP。文档整体与发布验收仍以主 agent 的最终记录为准。

最终只读审查另反馈一个可观测性残留：generateBatch 为部分拒绝设置的 lastError 警告，会被 runFlush await 后无条件清空。missing 与 legacyUntracked 已正确保留且实际测试通过，但该具体警告可能读不到。已建议把清错放在请求开始前，或仅在零拒绝/零 skip 时清除。本 agent 没有修改产品源码，最终处理由主 agent 负责。

后续主 agent 通知已修正 lastError 清空位置。本 agent 按其要求只读复核最新源码：runFlush 在调用 generateBatch 前清错，await 后没有再次清错，故生成过程中设置的部分拒绝警告能够保留。该修正由主 agent 编写；本 agent 没有为此再跑测试，也没有将主 agent 随后全套 400 项通过计入自己的亲跑结果。

## 交接与未完成事项

- 新增 11 项测试最终通过，自己的记录已完成；主 agent 统一更新日志索引并纳入后续集成。
- 实时语义拒绝的进度资格和 reducer 部分提交兼容性已由主 agent 修正，第 11 项独立回归通过；本 agent 不认领这些产品改动。
- 部分拒绝后的 lastError 警告被清空问题已由主 agent 修正，本 agent 最终只读复核了清错位置；没有遗留本 agent 已确认的 API 阻断问题。
- 账本测试使用内存 SQLite，关闭再打开的是会话运行时；不等于关闭数据库、重启进程或真实安装数据迁移验收。
- 模型为离线受控替身；不存在真实模型质量、真实网络超时或计费验证。
- mic 状态场景使用 mockStt=true 拒绝真实 STT 附着，不访问真实麦克风或网络 worker；不能据此宣称硬件或真人识别通过。
- 本 agent 未执行真实硬件、真实模型、真实 STT、打包安装或完整 M3 验收，也未重新运行全量回归或 UI 自动化。
- 合法空 ops 的进度仅表明一次符合操作约束的处理已完成，不证明信息完整、内容准确或全部成为节点。

## 证据与后续修订

- 任务合约来自本会话主 agent 发给 `/root/index_api_tests` 的 `.8 导图补建`任务消息。
- 实际新增文件：`packages/backend/test/mindmapRecoveryApi.test.ts`；本记录是另一项实际写入。
- 本会话工具输出：15:22 首次 10/10、611ms；15:25 回调整理后 10/10、586ms；15:27 首次 11 项因测试漏传 limit 为 10/11；15:28 修正后 11/11、575ms；shared 构建与最终离线 lint 均通过（Asia/Shanghai）。
- 本会话向 `/root` 发出的测试通过消息、实时进度/部分提交风险反馈、停止与超时边界反馈；主 agent 的其他验证仅按来源转述。
- 只读审查对象：`packages/backend/src/mindmap/MindMapAgent.ts`、`graph/GraphStore.ts`、`store/graphRepository.ts`、`store/sqlite.ts`、`server/apiServer.ts`、`runtime/SessionRuntime.ts`、`recording/RecordingController.ts`、`llm/OpenAICompatProvider.ts`、`packages/shared/src/graph.ts` / `graphEngine.ts`、`packages/frontend/src/components/RetrievalRecovery.tsx` 及既有 mindmapWire 测试。
- 2026-10-23，由 `/root/index_api_tests` 完成本记录。原 10 项通过后，因主 agent 要求追加回归曾恢复“进行中”；现最终 11 项通过，更新为独立测试与审查子任务完成，保留测试自身失败、修正过程、归属及未由自己验证的限制。
- 本记录不包含密钥、账号、会议正文或录音。
