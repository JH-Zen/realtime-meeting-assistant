# M1 软件修复与验证记录

日期：2026-10-22（Asia/Shanghai）。版本：`0.1.0-desktop-preview.2`。**桌面基础已完成；M1 真实硬件/模型验收及完整交付仍待完成。**

本文保留 2026-10-22 的环境与结果。2026-10-23 已准备 D 盘独立 CPU 识别环境，并完成固定语音的真实识别；当前步骤、结果和仍待验收范围见 [STT_CPU.md](STT_CPU.md)。

本轮从开发计划 M1 推进 I02、I08、新源码 I07，以及 I01 的采集准备/失败处理。沿用真实 React 页面、独立 Node 后端、共享协议和 SQLite；没有接入示例工作台，没有自动迁移旧数据，没有调用付费模型或下载大型模型。

## 修复内容与依据

| 问题 | 本轮结果 | 自动验证与边界 |
|---|---|---|
| I02 开始/结束竞态 | 开始与结束串行；停止立即取消待握手连接；运行时代次隔离旧回调；重复停止只排空一次 | 真实本地 WS 延迟握手探针覆盖停止、再次开始、迟到 ready/final、订阅释放；保留正常 flush 的尾句入库与派生处理断言 |
| I08 模拟暂停 | 暂停冻结剩余定时任务，继续按剩余时间播放，不跳过余下讲稿 | 单元测试核对完整讲稿；桌面页面暂停期间 final 数量不增长，继续后增长 |
| I08 配置/模式 | 布尔、整数、浮点与范围校验；回环地址/16 kHz 限制；真实 LLM 缺密钥失败，不再静默替换 | 18 项配置用例；启动错误页与日志可见。模式徽标显示配置的语音、实际 LLM/embedding provider；模块文件存在不等于推理效果已验收 |
| I07 浏览器访问 | 回环 Host、精确 Origin、端口专属 HttpOnly/SameSite=Strict cookie；HTTP/WS 共用凭证，后端重启时刷新；精确 CORS 与 CSP | HTTP/WS 拒绝来源与缺凭证测试；实际 Chromium 正式页、Vite 跨端口和后端重启测试。旧浏览器安装版未更新；不隔离同一用户的本机进程，不代表完整安全审计 |
| I01 准备与失败 | 先检查 worker 协议，再请求麦克风；支持取消准备并释放迟到授权结果；初始化 AudioContext 失败也释放设备 | 模拟配置/无 worker 时设备请求次数为零；原生虚拟设备验证晚到结果释放。worker 只允许一条录音连接，继续使用已有连接而不另开探测 |

修复前 `work/m1-lifecycle-before.log` 中 3 项生命周期/暂停回归失败；修复后这些断言通过。没有删除或放宽原业务断言。当前修复尚在工作区，未创建提交；后续提交时补充源码提交哈希。

## 源码、开发和浏览器验证

先构建 shared，再完成类型检查、lint、构建和测试。**43 个测试文件、321 项测试通过**。新增产品代码和工具无 lint 诊断；根 lint 退出码为 0，既有且被忽略的 `review-probes.ts` 保留 12 warning / 1 info。

```powershell
npm run build -w @rcc/shared
npm run typecheck
npm run lint
npm run build
npm test
node tools/verify-desktop.mjs --work=<全新测试目录>
node tools/verify-browser.mjs --work=<全新测试目录>
```

- 桌面开发态 **29 项检查通过**，证据：`work/m1-desktop-dev-final/verification.json`。涵盖真实业务窗口、模拟转写/导图/问答、JSON 文件操作、模拟暂停、采集前检查、权限取消、虚拟音频上传、单实例和正常/异常退出。
- 浏览器 **7 项检查通过**，证据：`work/m1-browser-final/verification.json`。使用本机 Edge 152.0.4191.53，验证正式业务页、HttpOnly 引导、WS、后端重启凭证刷新、陌生来源 HTTP/WS 拒绝、Vite 开发连接与模拟转写。测试只结束自己创建的后台、Vite 和浏览器。
- `npm run dev:desktop` 已完整执行：构建、独立业务窗口加载、正常关窗、启动命令退出码 0、无自建后端残留；证据为交付目录的 `dev-command-verification.json`。
- 源码日志：`work/m1-typecheck-final.log`、`work/m1-lint-final.log`、`work/m1-build-final.log`、`work/m1-tests-final.log`。

## 本地安装交付

固化安装包放在 `outputs/m1-desktop-preview.2/RCC-Desktop-Preview-Setup.exe`，同目录保存 `.sha256`、安装态 `verification.json`、旁路安装 `side-install-verification.json`、浏览器结果与包内容检查。最终安装态结论以 JSON 的 `ok`、检查清单和与安装包一致的 `installerSha256` 为准。上一轮桌面基础包与证据保留在 `outputs/desktop-preview/`。

```powershell
node tools/package.mjs --tier=desktop --out=.scratch/pkg-m1-preview.2
node tools/make-installer.mjs --desktop --staged=.scratch/pkg-m1-preview.2/desktop --out=outputs/m1-desktop-preview.2
node tools/verify-desktop.mjs --installer=outputs/m1-desktop-preview.2/RCC-Desktop-Preview-Setup.exe --work=<源码目录外的全新目录>
```

安装态应在含中文/空格的路径运行，PATH 只含 Windows 目录，不使用系统 Node 或源码；检查重装保留配置/SQLite、8787 占用、启动失败可见、退出无自建后台残留。旁路更新只针对 `D:\Apps\实时会议助手-桌面预览` 及其同名预览快捷方式；保留 `%LOCALAPPDATA%\RCC-Desktop-Preview` 下配置和会议库。旧安装、旧快捷方式和设计原型通过原有哈希基线复核。

**实际安装态 34 项检查通过**，独立目录 `D:\Apps\.rcc-desktop-verification\m1-preview2-final`；重装后 2 个 completed 会话保留。旁路安装已更新到上述预览路径，版本核对为 `0.1.0-desktop-preview.2`，用户配置和 SQLite 在重装前后哈希一致，快捷方式激活原窗口且后台只有一份。关窗后其后台已退出，旧版/旧快捷方式及设计原型哈希不变。包内容审计 4697 个文件，禁止资料计数为 0；不含 Python、模型权重、真实 embedding 运行时、源码 `.env` 或个人数据库。安装包校验值以旁边 `.sha256` 为准，不在被打包文档内嵌自身哈希。

进程、配置/数据/日志位置、启动退出及安全设置见 [DESKTOP.md](DESKTOP.md)。`npm run dev:desktop` 仍是明确的开发启动命令；`npm run package:desktop` 默认写 `outputs/desktop-preview/`，上述分步命令用于保留本轮独立版本。

## 真实 STT 与麦克风的缺口

定向环境检查：本机可用 Python 为 3.14.7，未安装 sherpa-onnx；项目约定模型目录及旧安装目录没有找到可用模型文件。没有扫描整个磁盘。后续需要独立 Python 环境、requirements 中的识别依赖、实际兼容的本地流式模型，再由用户手动启动 worker。桌面不会接管或终止手动 worker。

当前 worker 支持 sherpa-onnx 的流式 transducer（`tokens.txt` + encoder/decoder/joiner ONNX）或兼容的流式 zipformer2-CTC（`tokens.txt` + `model*.onnx`）；不能将任意 ONNX 或离线模型目录当作可用流式模型。路径检查/ready 仅是准备条件，实际加载和识别仍需验证。

| 层级 | 本轮结论 |
|---|---|
| 采集代码 | 7 项替身对象测试通过，覆盖初始化失败、停止及迟到授权结果释放 |
| 桌面虚拟麦克风 | 固定 48 kHz WAV 经原生 Chromium 采集、现有 AudioWorklet 降为 16 kHz PCM、WS 上传；验证 3200 bytes/100 ms、非静音及频率，暂停/继续/关窗释放 |
| STT 探测/传输 | 独立接收端只发送协议 ready/flush，不进行识别、不返回转写；继续测试使用单客户端约束 |
| 真实硬件、Windows 权限 | 未验收；自动选择原生权限框不能替代真人授权、无设备、占用和隐私设置测试 |
| 实际语音识别 | 未验收；没有真实模型，不将模拟讲稿、ready 或音频上传当作识别通过 |
| 十分钟会议、中文准确率、长跑、真实模型质量 | 未验收，不据此关闭 M1/I01/I14 |

后续人工步骤：准备模型与独立 Python 环境；用绝对路径启动 `services/stt-worker/stt_worker.py --model-dir <目录>`；将桌面用户配置 `MOCK_STT=false` 后重启；允许 Windows 和应用麦克风权限，连续说话至少 10 分钟，核对真实内容并验证暂停、继续、结束和设备释放。此过程不需要开启真实 LLM 或 embedding。

I03/I04 会话恢复、I05 补建、I06 断线音频缺口、I09/I10 摘要与引用、I11 工作台接入，以及 I13 旧浏览器启动器的 `/health` 误认与 PID 强制停止仍待后续处理。未将它们顺带标为解决。
