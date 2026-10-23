# STT 音频时间轴与缺口 · Codex 独立实现 agent

- 作者 / agent ID：`/root/index_api_tests`。
- 执行工具与模型：Codex 子 agent，PowerShell / 文件补丁 / 本地测试；具体模型标识未独立确认，不调用其他模型。
- 日期与对应软件版本：2026-10-23，`0.1.0-desktop-preview.9`。
- 记录类型：实时记录。
- 状态：本 agent 的实现与针对性验证已完成，待主 agent 总体集成与交付。新增 12 项及原适配器契约合计 26/26 通过。

## 任务与写入范围

本轮 M3 / I06：在带 captureId / seq / startTime / durationSec 的 PCM 输入上，将 worker 的已发送音频时钟映射到排除暂停的会话活动时间轴；保留输入跳跃和重连后的缺口，并区分明确未发送与可能未确认的范围。

只允许修改：

- `packages/backend/src/stt/SherpaSTTProvider.ts`。
- `packages/backend/test/sttAudioTimeline.test.ts`（新增）。
- `docs/agent-logs/2026-10-23-preview9/codex-stt-timeline.md`（本记录）。

保留全部已有脏改动，不修改旧测试断言、STTProvider 接口、shared 协议、Python worker、索引或版本。主 agent 已建立 shared/audio.ts 和扩展接口；这些不是本 agent 的贡献。

## 实际改动

| 文件 | 自己实施的改动 | 状态 |
| --- | --- | --- |
| 本记录 | 开工读取根 AGENTS、agent-logs README / TEMPLATE 后建立进行中记录 | 已写 |
| SherpaSTTProvider.ts | position 输入的样本计时、连续 metadata 合并、左右边界映射、不可用 / 背压 observed 缺口、意外断连 possible 范围、gap 回调 | 已实施 |
| sttAudioTimeline.test.ts | 新增 12 项真实本地 WS 替身与合成 PCM 的时间轴及生命周期测试 | 全部通过 |

### 实现细节与行为边界

- 每次成功调用可用 WebSocket 的 send 后，以 PCM s16le 样本数推进该连接的 worker 音频时钟；不按文本末尾推进，不信任输入 position 的 durationSec 来替代实际字节长度。
- metadata span 保存 worker 音频范围与 source 活动时间范围，不缓存音频。相同 capture、连续 seq 且 source 连续时合并 span；序号跳跃、source 跳跃或新 capture 保留边界。
- worker 重连后重新从音频 0 计时，按新 position 锚定 source 时间；已发送但没有文字结果的静音和断线期间的缺口不会被压缩到最后一条文字之后。
- 位于 span 交界的 start 选右侧 source，end 选左侧 source；跨缺口 utterance 可保留跨区间的 start / end，这不证明区间中间音频连续。
- 无 position 时保留原 clockOffsetSec 路径，原 sttAdapterContract 断言未修改；保留既有 seqOffset 并处理已见 seq=0 的重连偏移，避免同编号直接复用。
- 未 ready、worker 不可用或 socket.bufferedAmount 大于 256 KiB 时丢弃当前帧，按实际 PCM duration 报 backend_stt / worker_unavailable / observed，不排队重放；这一背压要求由主 agent 在会话中追加。
- 意外 worker 断开时，仅报告已定位、已发送且在 final 处理边界之后的 source 范围，标记 backend_stt / worker_disconnect / possible。source 本身不连续时分别报告，避免把未发送的中间区间也说成已发送。
- 正常 disconnect 保留既有 flush 路径，不报意外断连。停止后忽略迟到 sendAudio，不重启自动重连；正常 flush 的最后 final 仍能按原 span 映射。
- gap callback 的异常被隔离记录，不让持久化或订阅者异常破坏 provider 的断连清理。

SherpaSTTProvider 接手前已有未提交的握手缓冲、drainingSocket、可取消握手和 disconnectJob 改动；本 agent 保留这些已有实现，没有把它们整体归为自己的工作。

## 协作与归属

主 agent 负责前端与后端其余音频链路接入、共享接口、持久化、UI 及总体验证。本 agent 独立负责本文件范围，不再委派任务；不把其他人的实现或全量验证归为自己。

## 实际验证

| 执行方 | 检查 / 命令 / 证据 | 结果及证明范围 |
| --- | --- | --- |
| 本 agent | `npm run build -w @rcc/shared` | 通过；在本轮针对性测试前执行 |
| 本 agent | `npm test -- packages/backend/test/sttAudioTimeline.test.ts packages/backend/test/sttAdapterContract.test.ts` | 2 文件、26/26 通过，Vitest 1.49s；包括新增 12 项和未修改的原 14 项 |
| 本 agent | `npm exec --offline -- biome lint packages/backend/src/stt/SherpaSTTProvider.ts packages/backend/test/sttAudioTimeline.test.ts` | 2 文件通过，无自动修复 |
| 本 agent | `npm run typecheck -w @rcc/backend` | 当前后端包类型检查通过；不代表本 agent 编写其他后端改动 |

首轮测试全部通过，没有测试红灯、删减旧断言或通过放宽断言规避失败。

### 新增 12 项测试覆盖

1. 同一 worker 上 source 跳跃，start / end 左右边界、partial 及跨缺口 utterance 的准确映射。
2. 已发音频长于最后一条文字的 end，意外断开后报告未确认尾部；断线帧 observed，新 worker 的 0 时钟锚定新 source 时间，utterance ID 不复用。
3. 前一 worker 全程没有输出文字，仅已发静音，重连后仍以新 source position 定位，不回到 0。
4. 不连续 source 范围分别报告 possible，不把未发送的中间缺口合成“已发送”。
5. 100 个连续小帧形成一段 observable 未确认范围，核对 metadata 合并行为。
6. 调用方暂停不送 PCM，恢复使用新 capture，活动时间轴排除暂停墙钟时间，不凭空报告音频丢失。
7. 握手前的帧明确丢弃，缺口 duration 取实际 PCM 字节长度，即使 position.durationSec 不一致也不放大范围；ready 后不重放旧帧。
8. 真实 WS 连接上注入 bufferedAmount 背压读数，超过 256 KiB 时丢帧报告 observed；下一帧正常发送时 worker 时钟不包含丢弃帧，不重放。
9. 正常 disconnect / flush 的最后一句按映射落地，不报意外断连；关闭后的 caller PCM 被忽略。
10. final 已确认的完整已发范围，在意外关闭时不重复报告为 possible。
11. stop 取消排定重连，随后 worker 重启和迟到 caller 音频都不产生新文字或额外缺口。
12. 无 position 的 legacy 路径按原文本末尾 offset 连续编号 / 计时，不编造无法定位的 gap。

### 对主 agent 接入的只读审查

本 agent 只读查看了 SessionRuntime、RecordingController、API 音频入口和前端 microphone 接入：当前 SessionRuntime 根据 PCM 字节长度构建可信 duration，将 position 传入 provider；onAudioGap 受当前 provider / attachment generation / disposed 守卫；前端按样本数推进 source startTime，符合连续 span 合并条件。未修改这些文件。

这次审查未发现新增的确定性阻断问题；整体前端断线边界、缺口存储 / 导出 / UI、真实浏览器和桌面验收属于主 agent 与其他执行方范围，本 agent 未认领其验证。

## 交接与未完成事项

- 带 position 的输入以 backend 验证的 PCM duration 为准；不能靠已识别文本末尾推断全部已发送音频长度。
- 未发出的已定位帧报告 observed worker_unavailable；意外断开后尚无 final 确认的已发送范围报告 possible worker_disconnect，不等于文本一定丢失或送达 ACK。
- 正常 disconnect、关闭或暂停恢复不误报意外断连；dispose 后不重连、不落旧数据。
- 测试只用合成 PCM 和本地 WS stub，不发送真实音频、不加载模型、不下载资源；不构成真实识别或硬件验收。
- “已发送”在这里指 provider 接受并向本地 WS 发出数据，不是 worker 送达 ACK；possible 不是保证丢字，也不是保证无丢字。
- final 只提供 worker 宣告的处理边界，不证明所有静音、词或内容覆盖正确。新时间轴保留输入间隔，不能恢复已丢 PCM。
- 老调用方没有 position 时无法可靠定位丢失音频，所以继续旧时间戳兼容，不补造精确缺口。
- 连续 span 合并使 metadata 通常随 capture / 不连续范围增长，不逐帧保留 PCM；极端每帧都有 source 不连续时仍需保留相应 metadata。
- 暂停测试验证的是调用方停发与新 capture 的 provider 行为，没有启动真实麦克风、真实 AudioWorklet 或真实暂停按钮。

## 证据与后续修订

- 任务合约来自本会话 `.9 继续 M3/I06` 消息及主 agent 追加的 256 KiB 背压要求。
- 实际写入只限本记录、SherpaSTTProvider.ts 和新增 sttAudioTimeline.test.ts。旧 sttAdapterContract.test.ts 未改。
- 本会话工具输出：2026-10-23 18:43:55 开始的针对性测试，2 文件、26 测试通过、1.49s（Asia/Shanghai）；shared 构建、两文件 lint 与 backend typecheck 输出均通过。
- 本 agent 已向 `/root` 发送核心代码可集成通知、26/26 结果、backend typecheck 结果和只读接入审查结论。
- 2026-10-23，由 `/root/index_api_tests` 将记录从进行中更新为本子任务实现与针对性验证完成；总体验收仍由主 agent 记录。

## 2026-10-23 追加：完整安装载荷等待预算的只读评估

主 agent 请求独立评估：完整安装包约 507 MB / 4724 文件，首装约 8 秒成功，D / C 盘重装均触发固定 15 秒超时；拟仅将 WizardRegression.InstallReal 的完整载荷等待设为 90 秒，fixture 等待仍为 15 秒，全部 Assert 不变。包体、文件数、首装耗时、磁盘余量及安装日志只有 BEGIN 的观察来自主 agent，本 agent 未重新测量。主 agent 正另跑 120 秒上限的实际 quiet 安装；本评估时尚未据此确认最终结果。

本 agent 直接只读检查了：

- `tools/installer/WizardRegression.cs`：Wait 固定 15000ms；InstallReal 使用同一 Wait 等待完整安装，随后仍有成功页、桌面程序、内置 Node、版本收据和成功退出断言。
- `tools/installer/Installer.cs`：重装对每个已有非保留文件执行独占打开预检，之后逐文件解压到临时文件，再 File.Replace；首装则 File.Move。完整重装比首装多出大量旧文件访问 / 替换 I/O。
- `tools/installer/InstallerWizard.cs`、`tools/verify-real-installer.ps1`：安装工作在 BackgroundWorker 中，FAILED 由完成回调记录；测试超时会使 InstallReal 抛错、关闭 host，PS catch 随后 exit 1。由此中断宿主时，后台安装可能没有机会进入失败完成回调或临时文件 finally。
- `work/preview9-installed-retry.log` 与 `work/preview9-installed-final.log`：均为 Full native installation timed out，栈指向 WizardRegression.Wait / InstallReal，外层 result.status=1。它们证明 15 秒验证等待到期，没有证明安装引擎已报产品错误或死锁。这两份直接读取的是验证器输出，不是对全部安装引擎日志的独立遍历。
- `tools/verify-desktop.mjs`：外层安装进程超时为 120000ms，重装后仍校验数据库 hash、配置和模型标记保留。

**判断：**仅把 InstallReal 的完整载荷等待设为 90 秒是合理的验证预算调整；其他 fixture 保留 15 秒、所有 Assert 和重装保留性检查不变，可继续识别真实失败。90 秒仍有界，且相对外层 120 秒为 PS 编译 / 载入 / 截图留出约 30 秒。不能只凭放宽就宣布产品无缺陷；BEGIN 无 FAILED 或残留 tmp 也不能单独证明安装器卡死，因为验证器提前退出本身会截断后台任务。

已向主 agent 建议：保留这两次超时失败记录，结合正在执行的 quiet 安装实际耗时 / 退出码 / 版本收据，再用 90 秒 GUI 重装完成原有数据库、配置和模型保留断言。若 quiet 同样超时或确无进展，应继续定位产品 I/O / 锁等待，而不是再扩大所有 Wait 或跳过 Assert。

本次只新增这段评估记录；未修改生产或测试文件，未执行安装、测试、清理、终止进程或等待预算变更。
