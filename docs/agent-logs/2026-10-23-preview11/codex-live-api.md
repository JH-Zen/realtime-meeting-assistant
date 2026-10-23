# 实时任务 API 与故障验证 · codex-live-api

- 作者 / agent ID：Codex `/root/live_audit_api`，由主 agent 分派的独立测试 agent。
- 执行工具与模型：本机会话 PowerShell / 模型沿用父会话，具体标识未知。
- 日期与对应软件版本：2026-10-23，0.1.0-desktop-preview.11。
- 记录类型：实时记录。
- 状态：已完成子任务并交接主 agent；整版交付与硬件验收以主 agent 报告为准。

## 任务与写入范围

只新增 `packages/backend/test/liveTaskApi.test.ts`，只维护本记录。读取现有真实 SQLite、runtime 和 HTTP 路径，独立审查实时索引/导图任务审计方案。业务、schema、repository、UI 由主 agent 和其他 agent 实施，本人不改生产文件。接手时仓库有大量既有未提交和新增文件，保留且不归为本人贡献。

## 实际改动

| 文件 | 自己实际实施的改动 | 行为与原因 |
| --- | --- | --- |
| 本文件 | 建立责任、审查与验证记录 | 供后续 agent 接手 |
| `packages/backend/test/liveTaskApi.test.ts` | 新增并验证 17 项真实录音运行时/SQLite/HTTP 集成测试（初始 14 项，追加 3 项） | 证明实时任务来源、覆盖、故障、scope 隔离、长 ID 兼容与只读恢复，以及写图后审计故障/停止封存重试/513 段边界，不使用付费服务 |

## 协作与归属

主 agent 负责导图/API/UI，另 agent 负责 RetrievalCore，Qoder 负责独立模块测试。本人验证真实接口链路，不重复存储单元覆盖。测试提供可控模型替身，既不发付费请求也不触用户真实数据。

## 实际验证

待核心代码稳定后执行针对性测试。尚未执行任何本轮自动测试，未做真实 STT 或硬件验收。

## 交接与未完成事项

正在准备真实运行时任务、scope 过滤、源 ID 隐私、停止后的迟到写入与重启只读测试。自动恢复不在本子任务范围。

## 2026-10-23 独立方案审查与测试准备

向主 agent 反馈五个实质风险：实时/手动审计指针交错、512 源 ID 边界、部分导图不能按节点数冒充源覆盖、scope 必须过滤后限量、重开历史不能隐式发模型请求。主 agent 明确采用实时独立指针、部分结果独立 `incomplete` 终态、源 ID 唯一且上限 512、SQL 过滤后 LIMIT。此为主 agent 的实现决策，本人仅审查。

已新增 `packages/backend/test/liveTaskApi.test.ts`，预计 13 项参数展开后的集成测试，使用真实 RecordingController/SessionRuntime、事件总线、SQLite 与 HTTP，只有模型结果可控。一个测试直接由 MockSTTProvider 讲稿计时回调产生 final，证明模拟录音路径自动产生实时记录；其余使用显式合成 final 做可控故障准备。均不代表真实 STT 或硬件麦克风验收。

当前已实际执行 `npx biome lint packages/backend/test/liveTaskApi.test.ts`，通过。遵照分工，等待主 agent 通知业务接入稳定后再执行测试，不把准备完成写为功能验证通过。

## 2026-10-23 完成验证与交接

补充第六项兼容性风险：原文 ID 的原有契约只要求非空，新 sourceSegmentIds 若加入 128 字符上限，会让既有合法长 ID 的实时处理被审计阻止。主 agent 采纳，与现有原文契约对齐为单个 ID 非空、最多 512 个且唯一；本人只新增长 ID 的真实 runtime 集成断言，不修改 shared 或任何生产文件。

首跑 14 项时，13 项通过、长 ID 项超时。测试于本地 22:12:53 启动，shared/dist/recovery.js 于 22:12:59 才重建为新契约；实际读取了旧合约。重建后长 ID 单项通过；随后完整 14 项通过。部分结果测试进一步加强为精确断言 `status=incomplete`，没有放宽失败断言。只读重开测试亦记录所有 structured 请求（包括摘要），断言不产生任何此类调用。

| 执行方 | 检查 / 命令 / 证据 | 结果及证明范围 |
| --- | --- | --- |
| 本 agent | `npx vitest run packages/backend/test/liveTaskApi.test.ts`，最终日志 `work/preview11-live-api-final.log` | 14/14，通过；真实 SQLite/runtime/HTTP 与模拟 STT 回调路径。最终日志本地时间 22:13:53 |
| 本 agent | `npm run typecheck -w @rcc/backend` | 通过 |
| 本 agent | `npx biome lint packages/backend/test/liveTaskApi.test.ts` | 通过，无修复 |

实际覆盖：模拟录音回调在 provider 请求前形成 running 任务与 attempt；精确稳定源 ID、长 ID 不截断、重复 final 不重复调用；两 core provider 异常单次失败无隐式重试；部分向量与部分合法导图区分完整成功；NaN 向量不入库；manual/live/all 在 SQL 过滤后取最近 10 条、旧 manual 未知字段保持缺失、跨会话拒读；runtime.dispose 同步封存，迟到成功/异常均不改结果；审计创建失败不请求 provider；中文含空格文件库重开只读、任务元数据不随会议导出。

未执行本轮全仓测试、桌面打包、实际旁路安装或真实模型/麦克风验收。正常录音结束会先排空任务，而 dispose 封存是本测试中验证的取消边界，不将其描述为所有退出竞态均已修复。自动恢复、历史任务的外部导入导出不在本子任务范围。

已向主 agent 回报 API 14 项、typecheck、lint 通过及首跑旧 shared 竞争原因。主 agent / Retrieval agent 的生产修改不归为本人贡献。由主 agent 更新协作索引并完成全版回归与交付。

## 2026-10-23 追加独立故障证据（主 agent 再次分派）

仅在自身测试文件新增 3 项；已有 14 项断言保留，未修改任何生产文件：

1. **写图后审计失败**：真实 SQLite 已保存 1 节点和 2 段 processed 后，第一次实时 mindmap attempt-finish 元数据保存抛错。验证业务结果保留，任务标为 `interrupted/audit_failed`、remaining 未知，不虚构回滚；provider 只调用一次，不重发模型。
2. **停止封存单次写失败**：模型保持未完成时直接调用 mindmap.stop，第一次 interrupt 元数据写抛错。恰好尝试两次封存写；迟到成功结果及再次 stop 均不产生额外写入，图和 processed 均未写入，provider 只一次。
3. **512+1 缓冲边界**：配置大于批次上限的触发阈值，关闭检索订阅以隔离本边界，真实 TranscriptCore/事件总线缓冲 513 个唯一 final，再执行实际 mindmap.flush。模型替身收到 512、1 两批；两条实时任务成功，513 个源 ID 完整唯一、processed=513、pending=0，尾段 `source-512` 保留。

本 agent 再次实际执行：

- `npx vitest run packages/backend/test/liveTaskApi.test.ts`：**17/17 通过**，日志 `work/preview11-live-api-extra.log`，本地 22:16:26 开始。
- `npm run typecheck -w @rcc/backend`：通过。
- `npx biome lint packages/backend/test/liveTaskApi.test.ts`：通过，无修复。

这三项是主 agent 新 mindmap 路径的独立故障和边界证据；不是自动恢复、全仓验收、真实 STT 或硬件验收。结果及最新总数已发回主 agent。

## 2026-10-23 协作政策文档追加（用户最新指示）

主 agent 转达用户最新明确要求：“不等 qoder 排队了，全部用 gpt 的 agent 做”。本次文档追加授权仅涉及 `AGENTS.md`、`docs/QODER_WORKFLOW.md` 与本记录；未修改其他文件或执行产品代码。

- 更新根 AGENTS 当前协作政策：Codex 主 agent 与 GPT 子 agent 并行分工；直到用户重新授权前，不主动启动、分派或等待 Qoder；保存既有工具与历史，不能把无产出的排队请求记为贡献。
- 更新 QODER_WORKFLOW 顶部政策，全部旧流程/启动命令明确标为历史及手动参考，并写明不构成当前执行授权；保留第 6/8/9/10 版实际贡献、模型参数和既有工具示例，不抹除历史。
- 第 11 版本次 Qoder 没有产出。主 agent 告知已精确停止 Qoder34780、原可见 CMD26660 保留。本人未执行该停止操作，按来源记录，不写作本人验证或 Qoder 开发贡献。
- 只读发现主 agent 所属 `qoder-status.md` 仍有停止前描述，已反馈由其追加最新状态；本人按责任范围没有修改该文件。

验证仅为文档差异与关键措辞检查；本次无需、也没有重跑产品测试。此前本人 API 集成 17/17 的结论不因文档政策变化而重算。
