# preview.8：导图显式补建的独立核心测试 · Qoder agent

- 作者 / agent ID / 会话 ID：Qoder 编码 agent；agent ID 与会话 ID 无法在此环境确认，待核实。
- 执行工具与模型：Qoder（Read / Glob / Grep / Edit / Write；未使用 shell、网络、安装或子 agent）。会话模型显示为 DeepSeek-Flash（内置，1M 上下文）；底层实际模型参数待核实。
- 日期与对应软件版本：2026-10-23；对应 mindmap-preview8 快照，产品版本号待核实。
- 记录类型：实时记录。
- 状态：待集成。测试文件已写入，但本 agent 未执行测试；下一步由主 agent 接入真实仓库、审查并运行。

## 任务与写入范围

任务：在隔离的 mindmap-preview8 子目录内新增导图显式补建（`rebuildMissing`）的核心测试，覆盖历史只读、空操作、失败恢复、批次与重试上限、并发单飞、停止后的迟到响应、事务失败、账本持久化、跨会话隔离、旧图无账本与非法操作整批失败。

授权写入：`packages/backend/test/mindmapRecovery.test.ts`（新增）与本 `agent-record.md`。生产代码由主 agent 并行实现；本 agent 未修改现有测试、helpers、源码或父目录，未访问会议数据、密钥、模型、安装目录或网络。

## 实际改动

| 文件 | 自己实际实施的改动 | 行为与原因 |
| --- | --- | --- |
| packages/backend/test/mindmapRecovery.test.ts | 新增 16 个 Vitest 用例，构造内存 SQLite Harness，并通过第 6 参数 `readFinals` 接入持久 final。 | 覆盖 TASK.md 指定的恢复行为：历史状态读取不调用模型、未 start 的显式补建、空 operations 记账、瞬时故障重试、三次上限与后续恢复、单次最多 8 批、并发合并、等待 live 请求、stop 后迟到成功/失败不写且不重试、`putBatch` 一次失败后显式重试、持续写失败有界且不记账、GraphStore/agent 重建后读取账本、跨会话隔离、旧图 `legacyUntracked`、部分非法操作整批失败。 |
| agent-record.md | 建立并更新本记录。 | 记录范围、实际改动、未执行验证与交接疑点。 |

测试使用真实的 `SqliteGraphRepository`、`GraphStore`、`TranscriptCore` 和总线，仅以 `ScriptedLLM` 替代模型；事务失败用例对真实 `repo.putBatch` 使用 `vi.spyOn`，并以同步抛错的 `mockImplementation` 模拟 SQLite 同步事务失败，没有替换 core 或 repository。恢复测试大多不调用 `start()`，只有“等待 live 请求”用例启动实时链路。清理在 `afterEach` 中停止 agent、清空总线并关闭数据库，断言失败时也会执行。

## 协作与归属

生产实现、集成与最终测试执行由主 agent 负责。本 agent 只按 TASK.md 的接口合约编写测试，未采用其他人的草稿，也未接管生产代码归属。当前尚未集成到主仓库，未修改父目录已有成果。

## 实际验证

| 执行方 | 检查 / 命令 / 证据 | 结果及证明范围 |
| --- | --- | --- |
| 本 agent | 仅做静态复核；未运行 Vitest、tsc 或任何 shell 命令 | 本环境无 shell，且任务要求不执行命令；不能声明测试通过或类型检查通过 |

静态复核范围：导入路径与现有 `mindmapAgent.test.ts` 一致；断言只依赖 TASK.md 的公开合约（`recoveryStatus`、`rebuildMissing`、`processedSegmentIds`、`applyOps` 的进度语义与 `repo.putBatch`）；未改动已有断言。

## 交接与未完成事项

需要主 agent 核实并在真实仓库中执行的疑点：

- preview 子目录未包含 `sessionRepository.ts`、`transcriptRepository.ts`、`config/env.ts` 等依赖，且当前 `MindMapAgent`/`GraphStore` 仍是旧接口；测试按 TASK.md 合约引用 `rebuildMissing`、`recoveryStatus`、`processedSegmentIds` 与 `repo.putBatch`，需与主 agent 的生产改动一起编译。
- `putBatch` 的事务粒度假设为“每批一次”；一次事务失败后本测试要求该批保持未记账，并由下一次显式 `rebuildMissing` 成功补建。若实现把数据库写失败也计入 3 次自动逻辑重试，需先与 TASK.md 的“显式重试”语义对齐。
- `completedBatches` 的计数口径未在 TASK.md 中定义；测试按“成功完成的批次累计/本次补建完成批次”均会得到相同值的前提断言 2 和 8。若实现采用其他口径需调整。
- `legacyUntracked` 的判定依赖“旧图有节点、该会话无处理账本”；测试通过直接写入节点并 `hydrate()` 构造旧图，不伪造账本。
- `recoveryStatus.busy` 预期在补建请求挂起时为 true；`stop()` 后迟到 rejection 不应写入 `lastError`，也不应继续退避。
- 重试相关用例使用真实 200/400ms 退避，单个失败用例约耗时 0.6s；若 CI 对时长敏感，可在主仓库改用 fake timers，但本 agent 未执行验证。
- `processedSegmentIds()` 预期在 `hydrate()` 后读取持久账本；跨会话用例共用同一个内存数据库，直接验证账本与图按 session 隔离。

下一步：主 agent 接入生产实现后运行 `mindmapRecovery.test.ts` 与既有 `mindmapAgent.test.ts`；若生产 API 与上述合约有差异，以 TASK.md 合约为准调整测试或实现，并在此记录追加修订。

## 证据与后续修订

- 输入依据：mindmap-preview8/TASK.md、agent-record-template.md、现有 mindmapAgent.test.ts/helpers.ts 与源码。
- 本 agent 写入文件：`packages/backend/test/mindmapRecovery.test.ts`、`agent-record.md`。
- 执行证据：无。未运行测试，未产生命令输出或测试报告。
- 后续修订：待主 agent 集成与执行后补充。

## 2026-10-23 主 agent 集成追加（不改写上述作者原稿）

- Qoder 原始测试已实际写入任务副本；原稿保留在 `work/qoder-preview8-core-original.test.ts`，SHA256 `b4e62871649b4ff78903ac0ffdebfe6625b383323667c1ddb47fe766e726e192`。本记录正文由 Qoder 编写，主 agent 复制入项目并追加此节。
- 主 agent 首次运行结果为 14 通过、2 失败：原稿引用了实际不存在的 `SqliteGraphRepository.putBatch`。这不是产品检查通过。
- 主 agent 将故障注入点接到真实事务内的 `recordProcessedSegments`；持续失败三次后保持缺失，恢复写入方法后再次手动补建。保留图/账本均不写、后续成功的断言，将三次上限断言与既定合约对齐；没有删改接手前已有测试断言。
- 主 agent 还替换了 deferred 初始化的两处非空断言，以通过项目 lint。Qoder 原始快照及作者关于未运行测试的陈述保留；最终执行结果由主 agent 追加。
- 主 agent 修正后单文件16/16通过，随后与接口测试和既有测试一起完成50文件400测试全量通过。Qoder 本身未执行这些命令。原可见会话ID核实为 `bd220b1e-43e1-4242-a0ec-7ec46f9e90e4`；runtime-config证实dfmodel/1000000，reasoningEffort为null，不是max已生效的证据。
