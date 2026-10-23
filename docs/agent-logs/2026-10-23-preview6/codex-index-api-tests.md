# 检索索引补建 API 测试与独立审查记录

## 记录信息

- 作者 / agent ID：`/root/index_api_tests`。
- 记录类型：本轮补记。
- 日期：2026-10-23（Asia/Shanghai）。
- 对应版本：`0.1.0-desktop-preview.6`。
- 项目工作区：`D:\AI Workspace\Codex Workspace\实时会议助手`。
- 任务范围：M3 / I05 的显式检索索引补建基础；本记录不代表完整 M3 已完成。

## 任务目的与实际写入

为显式检索索引补建接口新增真实集成测试，验证用户主动触发、会话隔离、录音互斥、工作合并、失败可观测及停止后的迟到结果处理。同时按主 agent 的要求，对新增 API、前端入口及 Qoder 的 RetrievalCore 草稿做只读对抗性审查。

本 agent 实际新增的文件只有：

1. `packages/backend/test/retrievalRecoveryApi.test.ts`：10 项 API 集成测试。
2. `docs/agent-logs/2026-10-23-preview6/codex-index-api-tests.md`：本交接记录。

未修改产品源码、其他测试、版本文件、变更日志或开发计划；未回退、清理或认领仓库中的其他未提交改动。本 agent 运行 shared 构建会更新对应构建产物，该操作属于验证前置步骤，不属于本 agent 编写的业务实现。

## 新增测试的具体覆盖

测试夹具参考现有 `packages/backend/test/sessionRecovery.test.ts`，使用真实内存 SQLite、各 SQLite repository、SessionRuntime、RecordingController、createServer 和 RetrievalCore。向量提供器包装现有离线 MockEmbeddingProvider，只控制请求延迟与失败，不替换检索核心；LLM 方法的 spy 保留原实现，用于核对是否被调用。

1. **历史打开与状态查询只读**：打开未索引历史后读取状态，核对总数、已索引、缺失、busy、lastError 和批次数；不请求 embedding 或 LLM，不改变原文及会议完成状态。
2. **显式补建成功**：POST 返回 202 和当前会议状态；后台完成后保存的原文可以通过真实 retrieval.search 找到；原文字段不变，重复补建已完整的索引不会再次请求模型。
3. **连续请求合并**：受控阻塞第一批 embedding，连续发起 6 次 POST；状态可读到 busy=true，仅一批进入模型，释放后按批完成，最大并行批次数为 1，原文没有重复嵌入。
4. **每次最多八批**：以每批 2 段、共 17 段历史验证第一次只处理 16 段；GET 不会自动继续，下一次显式 POST 才补完剩余 1 段。
5. **无当前会议与错误会议 ID**：GET / POST 均返回 409、error=session_changed；不触发模型，不返回另一会议的索引状态，不向其他会议写入索引。
6. **录音与暂停互斥**：GET 可以只读当前录音状态，POST 在 recording / paused 状态均返回 409、error=recording_in_progress。测试利用 mockStt=true 时 start("mic") 拒绝真实 STT 附着的行为建立真实控制器状态，不访问实际设备或 STT 网络服务。
7. **真实过渡状态互斥**：在请求前置钩子中排入真实 closeSession 生命周期操作，验证状态仍为 viewing、但 transitioning=true 时仍拒绝补建；没有用空壳 core 或伪造 getter 替代这一检查。
8. **切换会议丢弃迟到结果**：旧会议补建的 embedding 尚未返回时打开另一会议；释放旧结果后旧、新会议均不产生隐式索引写入；旧 ID 请求被拒绝，新会议只有再次显式 POST 才建立索引。两会议使用重复 segment ID，以核对会话边界。
9. **持续失败可见且有界**：用假时钟推进补建退避，验证含初始请求在内共 3 次尝试；失败后缺失数保留、lastError 可读、原文不变，GET 不触发自动重试。
10. **保持桌面访问边界**：缺少桌面凭证或提供错误凭证时，两个新增接口均被现有 desktopAccess 拒绝，返回 403；不请求模型，不写索引。

## 本 agent 亲自执行的验证

以下操作均在项目工作区内执行，未调用真实模型或外网，未安装新依赖。

| 操作 | 本 agent 实际结果 | 证据范围 |
| --- | --- | --- |
| `npm run build -w @rcc/shared` | 通过；在最终 API 测试前再次执行通过 | 构建 shared，满足仓库要求的验证前置顺序 |
| `npm test -- packages/backend/test/retrievalRecoveryApi.test.ts` | 核心实现接入后，10/10 通过；Vitest 总耗时 479ms | 本 agent 新增的 10 项真实 API 集成测试 |
| `npm exec --offline -- biome lint packages/backend/test/retrievalRecoveryApi.test.ts` | 通过；只检查 1 个文件，无自动修复 | 新增测试文件的 lint |

首次运行 API 测试时，主 agent 已加入路由，但 RetrievalCore 新接口尚未集成；当时 3 项安全拒绝测试通过，另外 7 项因 recoveryStatus 未定义导致 GET 超时、或 rebuildMissing 不存在导致 POST 返回 500 而失败。已向主 agent 如实报告，未删减断言、未替换空壳实现。收到核心接入通知后重新先构建 shared，再运行原有 10 项测试并全部通过。

**验证归属边界：**主 agent 提到的全量 373 项测试结果属于主 agent 的验证记录；本 agent 没有亲自执行或独立复核该次全量运行。Qoder 核心测试及主 agent 的打包、桌面验证，也不计为本 agent 亲自执行。

本次补写日志没有运行新测试。

## 发现并反馈的问题及修正归属

### 前端异步响应与会话切换

- **旧 POST 阻塞新会议按钮**：最初的 RetrievalRecovery.tsx 以任意非空 submitting 阻止 rebuild，但按钮只在 submitting 等于当前 sessionId 时禁用。若 A 的 POST 响应悬挂后切到 B，B 的按钮可能显示可点但处理器直接返回。已向主 agent 反馈。
- **旧 GET 覆盖较新 POST 状态**：提交前发出的 GET 若迟到，可能把 POST 返回的 busy=true 覆盖为旧 busy=false，造成短暂错误显示。已向主 agent 反馈。
- **实际修正作者**：上述前端修正由主 agent 实施。本 agent 后续只读确认源码加入了会话作用域 cleanup、AbortController、按请求发起序号应用响应，以及仅检查当前会议提交的 guard；本 agent 未编写这些产品修正，也未运行前端 UI 自动化。

### RetrievalCore 状态与停止边界

- **isBusy 不含补建状态**：审查 Qoder 草稿及首次接入代码时，isBusy 仅返回 pumping，而 recoveryStatus.busy 包含 repairActive。现有 /api/debug 因而可能在补建时显示不忙。已反馈主 agent，建议将 repairActive 纳入 isBusy。
- **普通 live drain 的迟到写入**：repairBatch 已在 await embed 后检查 closed；普通 drainBatch 的旧路径在 await embed 后仍可能写库，catch 也可能在 stop 后发布 module.error。已反馈主 agent，建议补齐停止后的写入和错误发布守卫。新增 API 切会议测试验证的是 repair 路径，没有把普通 live drain 的问题误报成已覆盖。
- **串行范围说明**：补建与 live ingest 共用工作链，连续补建请求会合并；search 原有调用路径没有加入这条链，因此不能据此宣称所有 embedding 调用（包括 QA 查询）绝不并行。已提醒主 agent 准确描述范围。
- **实际修正作者与最后掌握状态**：主 agent 后续通知，这两项 core 修正已交给 Qoder 在独立副本实施，主 agent 负责后续集成和必要回归。本 agent 没有编写这些修正，也没有在这条通知后继续核验最终产品源码或重跑测试；最终集成状态应查主 agent / Qoder 的记录。

## 已知限制

- 这些是离线、进程内 API 集成测试，不是桌面安装包、浏览器操作、真实模型、麦克风硬件或真实 STT 验收。
- desktopAccess 用例验证的是未授权请求被拒绝，没有验证正式桌面窗口的完整授权成功流程。
- LLM 仅用于核对本轮状态查询与补建没有调用它；本记录不评价真实问答或检索模型的质量。
- 持续失败用例验证 embedding 请求失败与有界重试；本 agent 没有新增数据库事务写失败回归，该部分后续由主 agent 另行分配。
- 不将所有补建接口通过等同于完整 M3、其他业务问题解决或正式发布完成。
- 日志记录的是本 agent 实际参与及亲自验证的范围，其他 agent 随后的修正、全量回归和桌面验收需结合其独立记录核对。

## 后续建议

1. 主 agent 集成 Qoder 的 isBusy 与普通 live drain 停止守卫修正后，运行相应核心测试及必要 API 回归，并在自己的记录中附上结果。
2. 为数据库 putBatch 事务失败补充回归，核对索引缺失仍可见、重试有界、正常工作链没有被失败污染。
3. 按本轮实际交付范围保留“显式检索索引补建基础”的描述；真实设备、真实 STT、真实模型和正式桌面场景分别留存验收证据。

## 可核对证据

- 实际新增测试：`packages/backend/test/retrievalRecoveryApi.test.ts`。
- 夹具参考：`packages/backend/test/sessionRecovery.test.ts`；本 agent 没有修改该文件。
- 只读审查对象：`packages/backend/src/server/apiServer.ts`、`packages/frontend/src/components/RetrievalRecovery.tsx`、`packages/frontend/src/net/api.ts`、`packages/frontend/src/state/sessionStore.ts`、`work/qoder-drafts/RetrievalCore.ts`，以及首次集成后的 `packages/backend/src/retrieval/RetrievalCore.ts`。
- 本会话中本 agent 发给 `/root` 的初次测试结果消息、前端竞态反馈、core 草稿审查、最终“10/10、479ms”通过消息，以及主 agent 后续将两项 core 修正交 Qoder 实施的消息。
- 主 agent 的全量测试与桌面交付结果请查统一日志索引和主 agent 自己的记录；本文件不代替其执行证据。

本记录未包含密钥、账号资料或真实会议正文。
