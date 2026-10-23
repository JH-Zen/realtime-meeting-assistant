# 实时检索批次审计 · Codex live_retrieval

- 作者 / agent ID：Codex `/root/live_retrieval`。
- 执行工具与模型：Codex 工具；具体模型标识未独立查询。
- 日期与对应软件版本：2026-10-23，`0.1.0-desktop-preview.11` 开发中。
- 记录类型：实时记录。
- 状态：已完成，待主 agent 集成全量回归与交付。

## 任务与写入范围

按主 agent 分工，为实时检索批次增加持久任务与尝试记录；仅修改 `packages/backend/src/retrieval/RetrievalCore.ts`、新增 `packages/backend/test/liveRetrievalAudit.test.ts` 及本记录。保留接手时的手动 repair、既有断言及所有其他脏改动，不负责版本、API、页面、安装或发布。

## 实际改动

| 文件 | 自己实际实施的改动 | 行为与原因 |
| --- | --- | --- |
| `packages/backend/src/retrieval/RetrievalCore.ts` | 在每个实际实时 drain 请求前创建 live 任务及第一次尝试，批次最多 512 个唯一来源 ID | 元数据必须先落库；剩余队列继续独立 drain，不增加自动模型重试 |
| 同上 | 使用既有 `isUsableVector` 验证维度、NaN、Infinity；只存有效向量，分别记录成功、部分、无效输出及异常 | 防止非有限向量被归一化为替代零向量后误算成功 |
| 同上 | 每条积压拒绝记录无尝试的 `backlog_full` live 任务 | 原文仍由 TranscriptCore 保存；UI 保留每个溢出 episode 一次提示，审计故障也有限提示 |
| 同上 | 独立 activeLiveAudit 指针、同步 stop 封存、最多一次即时元数据重试、重复 stop 不重复写 | 避免覆盖已排队的手动补建审计；迟到成功/失败不落业务或任务，不在 finally 重开 |
| `packages/backend/test/liveRetrievalAudit.test.ts` | 新增 23 项真实 SQLite / RetrievalCore 测试，受控 provider 与定点存储故障注入 | 覆盖调用前持久记录、有效/部分/无效/异常输出、512 上限与去重、积压、迟到结果、临时/持续审计写失败及无 repo 兼容 |

对抗性复查重点：手动 repair 可在实时 provider 悬挂时先创建独立审计，因此两个 audit 不能共用指针；测试已验证 stop 同时封存且迟到结果不会复活。另一个边界是业务向量提交后审计完成写失败：保留真实向量，将任务标为 `interrupted/audit_failed`，不伪装为回滚，不重发模型。部分输出按主 agent 新增 helper 第三参数使用 `incomplete` 终态，并保留 `incomplete_output` 原因。

## 协作与归属

共享任务合约、RecoveryAudit live 元数据与部分终态参数由主 agent 提供并构建；本记录不将其归为自身实现。API、页面、导图、版本、打包、安装及全量回归由其他参与者负责。本文件本来已含第 6/10 版手动补建代码，本次仅新增实时审计，不把整份 git diff 归为本人贡献。

## 实际验证

| 执行方 | 检查 / 证据 | 结果及证明范围 |
| --- | --- | --- |
| 本 agent | `npx vitest run packages/backend/test/liveRetrievalAudit.test.ts`；`work/preview11-live-retrieval-own-tests.log` | 1 文件、23 项通过 |
| 本 agent | 新增测试与既有 `retrievalCore.test.ts`、`retrievalRecovery.test.ts` 联跑；`work/preview11-live-retrieval-tests.log` | 3 文件、52 项通过，原断言未删改 |
| 本 agent | `npx biome lint packages/backend/src/retrieval/RetrievalCore.ts packages/backend/test/liveRetrievalAudit.test.ts` | 2 文件通过，无新增警告 |
| 本 agent | `npm run typecheck -w @rcc/backend` | 通过 |

受控 provider 返回固定向量；SQLite 表、事务及审计 repository 使用真实实现。未调用外部模型，不代表真实 embedding、硬件麦克风或真实 STT 验收。曾在联跑命令额外列出不存在的 `recoveryTaskAudit.test.ts` 模式，Vitest 实际只运行上述三份存在的测试；报告以实际三文件 / 52 项为准。

## 交接与未完成事项

业务向量和任务审计不在同一事务，审计失败时剩余数可为未知；页面必须如实显示。持续存储故障时两次即时封存都失败，durable running 行保留，现有下次启动 `interruptRunning()` 封存机制负责处理，测试已验证。停止时尚未进入 drain 的队列仍按既有语义清空，原文保留供手动补建。本次未新增自动模型重试，也未改变 search 或手动 repair 行为。全量回归、正式桌面验收与交付由主 agent 完成。
