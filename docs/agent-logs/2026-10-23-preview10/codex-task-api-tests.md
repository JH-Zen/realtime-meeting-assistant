# 持久补建任务接口测试与审查 · Codex audio_gap_api_tests

- 作者 / agent ID：Codex `/root/audio_gap_api_tests`，沿用此前接口测试子 agent；当前工具未提供可独立确认的模型名。
- 日期与版本：2026-10-23，目标 `0.1.0-desktop-preview.10`。
- 记录类型：实时记录。
- 状态：已完成；19 项独立测试和本文件 lint 通过，已复验主 agent 对暂时封存失败的修复。

## 任务与写入范围

只写新增 `packages/backend/test/recoveryTaskApi.test.ts` 和本记录。主 agent 负责两个 core、helper、runtime、API、页面；另一 agent 负责 SQLite repository。既有源码与其他参与者脏改动均保留，不修改原测试、生产代码、版本或索引。

## 实际改动

| 文件 | 自己实际改动 | 证明范围 |
| --- | --- | --- |
| `packages/backend/test/recoveryTaskApi.test.ts` | 新增 19 项参数化/集成/故障测试 | 真实 SQLite、两个 core、SessionRuntime、RecordingController、HTTP；另有真正启动 `src/index.ts` 的独占子进程用例 |
| 本记录 | 实时审查与结果 | 保留发现、失败和负责人归属 |

覆盖任务最近 10 条与会话隔离、repo 缺失或读取失败 503、并发 coalesce 和运行中尝试可读、完成后重开持久与零缺失不建新任务、部分索引结果输入/保存计数、失败三次与敏感信息不落入任务、8 批/24 尝试上限、切换会议即时中断及迟到成功/失败抑制、首个 await 前任务可封存、暂时 attempt 保存失败处理、暂时取消封存保存失败、导出/导入不携带本机任务，以及实际后台启动封存所有会话孤儿任务。

## 协作与归属

独立审查风险通过协作消息反馈主 agent；生产修复由其负责，不能归入本 agent 实现。避免重复仓库 agent 的内部存储实现测试，以实际 runtime/API 行为为重点。

首轮方案审查已反馈：

1. coalesce 检查后、任何 await 或模型调用前创建任务；stop/dispose 需同步封存，不等被挂起模型响应。
2. 8 批 × 3 次记录是 core 的批次尝试，provider 内部 HTTP 重试不等于新增批次尝试，页面表述需保留边界。
3. 业务结果提交成功但审计写失败时，不能单凭 lastError 将已完成结果描述为未处理；状态与 durable remaining 应一致。
4. 遗留 running 封存只在后端启动执行并覆盖所有 session，不应在构建每个 runtime 时中断同进程现有任务。
5. 导入不继承本机操作历史，不改变原有明确导入时的 embedding 行为；不应误测为任何模型请求都被禁止。

主 agent 采纳上述创建时序、同步中断、startup 单次接入和页面表述边界。接入由主 agent 实现，本 agent 未改生产代码。

实证缺陷：`RecoveryAudit.interrupt()` 在持久化前设置 sealed=true。注入仅第一次 interrupted save 失败（后续数据库完全可写），停止/关闭后释放模型，finally 见 active=false 不再封存。重新打开会话时 API 仍显示 task 和 attempt running，但实际两个 core 均已闲置、无结果。为 retrieval 和 mindmap 各保留一项拒绝假 running 的断言并反馈主 agent。未放宽任何断言。

主 agent 随后分开“禁止新工作”和“已持久终态”两个事实：sealed 后仍允许对尚在 durable running 的 metadata 显式再次封存，两个 core 在 stop 首次保存失败时仅立即重试一次 metadata。生产修复归主 agent。本 agent 给两项故障测试补上精确计数，停止时恰好两次封存写（首次失败 + 一次兜底），迟到模型返回后保持两次，模型调用保持一次、业务覆盖保持零，最终亲自重跑 19/19 通过。

## 实际验证

| 执行方 | 检查 | 结果与边界 |
| --- | --- | --- |
| 本 agent | `npm run build -w @rcc/shared` | 通过，按约定先编译 shared |
| 本 agent | `npx vitest run packages/backend/test/recoveryTaskApi.test.ts` 首轮 | 17/17 通过，包含真实 composition-root 后台启动/IPC 正常退出 |
| 本 agent | 同命令，加暂时取消封存失败用例 | 17 通过、2 失败，实证上述两 core 同类缺陷 |
| 本 agent | 同命令，主 agent 修复后最终复跑 | 19/19 通过；保留原断言并额外精确检查两次 metadata 写上限与迟到不再写 |
| 本 agent | `npx biome lint packages/backend/test/recoveryTaskApi.test.ts` | 首轮通过，无诊断 |
| 本 agent | 同 lint，最终文件复跑 | 通过，无诊断 |
| 本 agent | `npm run typecheck -w @rcc/backend` | 通过 |

所有模型调用均为合成替身，不使用真实 STT、硬件或付费模型。启动测试使用临时中文含空格目录与独立 DB、全部 mock、独占 IPC token/实例标识和动态端口，只通过自己 child 的 IPC 退出，检查 exitCode=0、signalCode=null；不接管实际 app、旧后台或用户 worker。

## 交接与未完成事项

由主 agent 完成全仓/桌面/安装验证。业务数据和审计写入不承诺同一事务，实际覆盖进度与审计应分别呈现；持续磁盘失败无法承诺落库，后续启动封存仍需保留。代码复核确认两次 metadata 都失败时不会进行模型重试，sealed 阻止迟到 finish/write，startup 下次仅封存而不自动修复业务；本文件针对一次暂时失败实证，不将持续真实磁盘故障恢复称为已验收。

## 证据与后续修订

可定位测试为 `packages/backend/test/recoveryTaskApi.test.ts`。本 agent 未修改 root 或 repository agent 的生产源码、版本、已有测试、索引及安装文件，也未执行全仓回归或真实 STT/硬件验收。后续整体结果由主 agent 另行记录。
