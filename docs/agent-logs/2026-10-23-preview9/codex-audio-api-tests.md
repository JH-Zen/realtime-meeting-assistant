# 音频缺口接口与故障测试 · Codex audio_gap_api_tests

- 作者 / agent ID：Codex `/root/audio_gap_api_tests`，本轮由主 agent 委派；工具未提供可独立核实的模型名。
- 日期与对应软件版本：2026-10-23，目标 `0.1.0-desktop-preview.9`。
- 记录类型：实时记录。
- 状态：已完成；11 项独立测试与本文件 lint 通过，两项实证缺陷均由主 agent 修复并已复验。

## 任务与写入范围

只写 `packages/backend/test/audioGapIntegration.test.ts` 和本记录。主 agent 负责 shared、存储、运行时、HTTP 与页面，另一 agent 负责 Sherpa provider，Qoder 提供核心连续性测试。接手时存在大量既有脏改动，不回退、清理或将其归为自己的成果。

## 实际改动

| 文件 | 自己实际实施的改动 | 行为与原因 |
| --- | --- | --- |
| `packages/backend/test/audioGapIntegration.test.ts` | 新增 11 项独立集成/故障测试 | 真正经过 WebSocket 命令、RecordingController、SessionRuntime、SQLite、HTTP 读取与文件导入导出，语音 worker 仅为本机协议替身 |
| 本记录 | 实时贡献与审查记录 | 区分自己的测试及生产负责人修复，保留失败事实 |

测试范围：采集缺帧持久与导出再导入重映射、相邻同类合并与会话/stage/reason/certainty 隔离、过期 session 拒绝、损坏 PCM 与重复倒序不转发、整段未收到和尾部丢帧、真实 worker socket 断线后的不确定/确定下游区间、旧文件兼容与不声称完整、历史会议迟到 end 写入拒绝、非法导入原子拒绝、中文空格文件路径关闭重开保留。

## 协作与归属

不修改其他 agent 的生产源码、版本、原测试或记录索引。独立发现的问题反馈给主 agent，由对应负责人修复。

2026-10-23 独立审查实证发现：`audio.capture.end` 原路径仅检查当前 sessionId，直接调用未 disposed 的历史 runtime；打开已完成会议后，全新 captureId 的 end(nextSeq=5,endTime=0.5) 可新增 0..0.5 的 capture_tail。第 10 项测试已保留拒绝写入断言并复现失败，已反馈主 agent，建议由 RecordingController 在录音生命周期入口门控，保留正常结束前的合法尾部证据。

主 agent 随后修改了 RecordingController 及 API 的 end 入口门控，此生产修复归主 agent。本 agent 加入第 11 项对抗性测试后，亲自重跑确认历史 end 拒绝测试通过。

第二个独立复现：已有 capture-a 的合法帧后，另一个 capture-b 的 seq=1 且 startTime==originTime（声称漏前序帧但没有时间缺口，属不合法）在返回 null 前已经 retire 旧 capture 并替换 active，导致随后合法的旧 capture 帧永久拒收。第 11 项真实 WS 测试保留 worker 应收两帧的断言，实际只收到一帧，已反馈主 agent 要求候选状态验证通过后再提交状态变更。

主 agent 随后把 AudioContinuity 新 capture 的校验改为先验证局部候选、成功后才提交状态；此生产修复归主 agent。本 agent 最终亲自重跑全部 11 项均通过。导入导出独立审查未发现本轮范围内其他阻断：foreign session、重复 gap ID、反向时间在写入前拒绝；新 sessionId 重映射可与原会议保留相同 gap ID；旧文件缺字段不会被测试或页面宣称完整。

## 实际验证

| 执行方 | 检查 | 结果及证明范围 |
| --- | --- | --- |
| 本 agent | `npm run build -w @rcc/shared` | 通过，先编译共享契约 |
| 本 agent | `npx vitest run packages/backend/test/audioGapIntegration.test.ts`（初版） | 9/9 通过 |
| 本 agent | 同命令，加入对抗性历史 end 测试 | 9 通过、1 失败，实证上述历史写入漏洞，未削弱断言 |
| 本 agent | 同命令，主 agent 修复历史 end 后再加入新 capture 不污染测试 | 10 通过、1 失败；历史 end 门控实证通过，实证新候选状态提交过早问题 |
| 本 agent | 同命令，主 agent 修复两项后最终复跑 | 11/11 通过，未修改或削弱已有断言 |
| 本 agent | `npx biome lint packages/backend/test/audioGapIntegration.test.ts` | 通过，无诊断 |
| 本 agent | `npm run typecheck -w @rcc/backend` | 通过 |

以上只证明合成音频和本机协议下的连续性及保存行为，不证明真实识别或硬件麦克风验收。本 agent 未运行全仓回归、桌面验证或打包安装，主 agent 的后续结果另见主记录。

## 交接与未完成事项

主 agent 继续整体回归与交付。页面始终提示“没有记录也不代表录音完整”，不会因旧文件缺字段或空数组声称完整。

正常采集停止先发送 end 再发送 pause/stop，因此门控保留结束前合法尾部。离线 pending end 在 onopen 先补发且录音仍 recording/paused 时可收；已结束会话不再接受迟到写入，可能未确认尾部以 transportLost+finishAt 保守记账，不承诺完整覆盖。

## 证据与后续修订

可定位测试即 `packages/backend/test/audioGapIntegration.test.ts`。主 agent 保存了其集成执行证据 `work/preview9-gap-integration.log` 与 `work/preview9-audio-candidate.log`（保存/执行归主 agent）；本 agent 在其修复后另行亲自执行单文件测试，11/11 通过。未修改 shared、生产模块、版本或索引。
