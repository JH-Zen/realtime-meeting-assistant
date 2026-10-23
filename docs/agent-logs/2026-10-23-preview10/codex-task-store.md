# 恢复任务持久化 · Codex 独立存储 agent

- 作者 / agent ID：`/root/index_api_tests`。
- 执行工具与模型：Codex 子 agent；PowerShell、文件补丁和本地 SQLite 测试；更具体模型标识未独立确认，未调用其他模型。
- 日期与对应软件版本：2026-10-23，`0.1.0-desktop-preview.10`。
- 记录类型：实时记录。
- 状态：本范围已完成，定向测试、lint 与后端类型检查通过；整体版本集成和全量验收由主 agent 负责。

## 任务与写入范围

实现 SqliteRecoveryTaskRepository 的 create / save / list / interruptRunning，保存经 shared schema 校验的操作元数据，禁止原始错误文本和业务内容进入任务 JSON。启动中断处理仅改运行中的任务与尝试，不调用模型或修改原始会话资料。

允许修改的文件只有：

- `packages/backend/src/store/recoveryTaskRepository.ts`（新增）。
- `packages/backend/src/store/sqlite.ts`（仅增量新表 / 索引）。
- `packages/backend/test/recoveryTaskRepository.test.ts`（新增）。
- `docs/agent-logs/2026-10-23-preview10/codex-task-store.md`（本记录）。

保留已有全部未提交改动，不改 shared、core、runtime、API、版本、索引或其他测试。sqlite.ts 接手时已有历史未提交改动，本 agent 只认领恢复任务表与索引的增量。

## 实际改动

| 文件 | 自己实施的改动 | 当前状态 |
| --- | --- | --- |
| 本记录 | 读取根 AGENTS、日志 README / TEMPLATE 后建立进行中记录，完成后补充实际结果与交接 | 已完成 |
| recoveryTaskRepository.ts | 接受 DatabaseSync；create 使用 INSERT，save 用同一 id / sessionId / kind 且原 status=running 的单条条件 UPDATE；list 只读且稳定排序；interruptRunning 使用 BEGIN IMMEDIATE / COMMIT / ROLLBACK | 已完成 |
| sqlite.ts | 仅新增 recovery_tasks 表与 idx_recovery_tasks_session_time 索引，外键随会话删除；JSON、kind / status / started_at 元数据并存 | 已完成；其他既有脏改动不属于本 agent |
| recoveryTaskRepository.test.ts | 新增 13 项真实 SQLite 测试，含参数化 4 种终态；不改现有断言 | 13/13 通过 |

写入与读取均经 RecoveryTaskSchema 解析；保存的 JSON 只含 schema 定义字段，未知 rawError、prompt、response 等字段被剥离。中断处理只改变运行中的任务和尝试；保留已结束尝试、进度数字以及原始会话资料。结束时间取当前时间、任务开始及既有尝试时间的最大值，覆盖系统时钟早于已有记录的情况。

## 协作与归属

shared/recovery.ts schema 和 RecoveryAudit helper 由主 agent 建立。主 agent 负责 API 与后续接入，本 agent 不认领其实现或全量验证。

主 agent 已修正构造约定：与其他 repository 一致接受 DatabaseSync，以 `new SqliteRecoveryTaskRepository(store.db)` 构造；不新增 SqliteStore 类型。

主 agent 随后为 shared schema 增加成功结果、成功批次数与时间范围不变量。本 agent 在首次测试前适配自己的 fixture，使成功尝试 savedCount=inputCount、completedBatches 等于成功尝试数，且尝试时间处于任务起止范围内；没有修改或放宽 shared 合约。已向主 agent 报告实现就绪及 13/13、lint、typecheck 结果。

## 实际验证

| 执行方 | 检查 / 命令 / 证据 | 结果及证明范围 |
| --- | --- | --- |
| 本 agent | `npm run build -w @rcc/shared` | 成功；先于测试生成当前 shared 产物 |
| 本 agent | `npm test -- packages/backend/test/recoveryTaskRepository.test.ts` | 首轮 1 文件、13/13 通过，2026-10-23 19:12:38 本地运行，Vitest 总时长 374ms |
| 本 agent | `npm exec --offline -- biome lint packages/backend/src/store/recoveryTaskRepository.ts packages/backend/src/store/sqlite.ts packages/backend/test/recoveryTaskRepository.test.ts` | 3 文件通过，无自动修复 |
| 本 agent | `npm run typecheck -w @rcc/backend` | 通过；生产代码的后端 TypeScript 检查，测试行为另外由上述 Vitest 覆盖 |
| 本 agent | 最终只读核对目标文件状态、sqlite.ts diff、日志模板 | sqlite.ts 本人增量仅恢复任务表 / 索引；保留其余已有修改 |

13 项覆盖如下：

- schema 投影剥离合成 rawError / prompt / response；修改输入和读取结果不会修改已保存记录，save 同样剥离扩展字段。
- create 只允许 running，同 ID 重复 / 跨会话重复不能覆盖原记录。
- 正常保存运行进度及最终成功；不存在 ID、跨 session、跨 kind 均拒绝，旧记录保持。
- succeeded、incomplete、failed、interrupted 四种终态分别验证：有效迟到 running 回调和终态重复写均拒绝，启动中断不改终态。
- 负数 / NaN / Infinity、无效 code、结束状态错配、保存数超过输入、重复尝试、尝试数量、时间和成功计数不变量均拒绝且不写。
- 最近 10 条、上限 50、时间相同时 id DESC 稳定排序、会话隔离、非法 limit 拒绝；SQLite query_only 模式仍可 list。
- 跨会话中断运行任务、只中断 running 尝试、保留成功尝试与计数；未来时间戳不倒退；第二次调用返回 0，迟到 save 拒绝。
- 真实 SQLite trigger 让第二个中断写失败，确认整笔事务回滚；移除测试 trigger 后可重新中断。
- 缺失父会话写入拒绝，删除一个会话只级联删除其任务。
- 中文及空格路径中模拟无任务表的旧库，增表、重开、中断持久化、再次重开；合成会话、原文、图节点、音频缺口原行完全保留。

没有测试失败后放宽断言；没有运行真实模型、音频、网络、安装包或本轮全量测试。临时 SQLite 文件只含合成数据，清理前检查绝对路径确为测试专用临时子目录。上述执行结果来自本 agent 本轮工具输出，主 agent 的集成 / 全量结果不归本 agent。

## 交接与未完成事项

- 调用方式为 `new SqliteRecoveryTaskRepository(store.db)`。构造与 list 无中断或模型副作用；启动入口须显式调用 `interruptRunning()`，由主 agent 接入。
- `interruptRunning()` 自行开启同步写事务，适用于启动恢复入口；不要从另一笔尚未结束的同连接事务内嵌套调用。
- 执行过一轮独立对抗性核对：检查条件写入能否挡住迟到回调、重复 ID 能否跨会话覆盖、第二笔失败是否半提交、将来时间是否逆序、读取是否偷偷写入。现有实现和针对测试支持这些边界，未发现阻碍接入的问题。
- 仓库层只接受 schema 内的操作元数据；不修复外部直接改坏的 JSON，非法已存 JSON 会抛错；不承担 UI 轮询、模型调用、历史任务清理策略或完整 M3 验收。
- 最优先下一步是由主 agent 验证启动中断调用与 API 读列表接入，然后执行其负责的相关及全量回归。不要将本独立存储交付扩称为完整版本验收。

## 证据与后续修订

合约来自本会话 `.10 独立存储任务`、构造参数更正及 shared 不变量更新消息。可核对代码为 [repository](../../../packages/backend/src/store/recoveryTaskRepository.ts)、[新增测试](../../../packages/backend/test/recoveryTaskRepository.test.ts)、[增量数据库 schema](../../../packages/backend/src/store/sqlite.ts)；实际执行结果可在本 agent 会话 2026-10-23 19:12 的本地构建 / 验证工具输出核对。

2026-10-23，`/root/index_api_tests`：将进行中记录更新为已完成，补充 13/13、lint / typecheck、对抗性检查与边界；未修改其他 agent 记录、统一索引或版本号。
