# 本地 CPU 语音识别：安装、使用与验证

更新：2026-10-23（Asia/Shanghai）。按用户选择，使用中英双语 Zipformer int8，只使用 CPU。**固定语音文件的真实识别链路已通过；实际硬件和十分钟真人会议仍待验收。**

## 已安装的内容

| 内容 | 本机位置 / 版本 |
|---|---|
| 独立服务根目录 | `D:\Apps\实时会议助手-STT-CPU` |
| 模型 | `models\sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20` |
| Python 环境 | `.venv\Scripts\python.exe`，Python 3.12.13 |
| 基础 Python | `D:\Programming Environment\Python\cpython-3.12.13-windows-x86_64-none\python.exe`；venv 依赖此基础解释器，不是便携 Python 包 |
| 识别运行时 | sherpa-onnx / sherpa-onnx-core 1.13.8 CPU 版、websockets 17.3 |
| CPU 设置 | 明确 `provider=cpu`，2 线程，greedy_search，16 kHz |
| 服务脚本 | `service\stt_worker.py`；启动脚本 `start-cpu.ps1` / `启动CPU语音服务.bat` |
| 服务配置 | `stt-cpu.json`，只含 CPU 线程与模型位置 |
| 服务日志 | `logs\worker-日期时间.log` |
| 桌面配置备份 | `backups\desktop-env-日期时间.env`；可能含用户密钥，请勿分享 |

模型来自 [sherpa-onnx 维护者的 Hugging Face 仓库](https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20)，固定 revision `98590b7ed6443e77b714204da2757d75e1a642f4`，模型卡标注 Apache-2.0。仅下载 encoder/decoder/joiner 的 int8 文件、词表/说明及 5 个官方测试 WAV，总计 **199,483,653 bytes**；未下载完整 fp32 权重、其他模型或 CUDA 版运行时。

权重按上游 LFS SHA-256 检查；小文件按固定版本的 Git blob SHA-1 检查，安装后统一生成本地 SHA-256 清单 `模型目录\checksums.json`。仓库中的 `services/stt-worker/cpu-model.json` 固定来源、版本、字节数和校验信息，不含模型二进制。核心桌面安装包仍不包含 Python、模型、会议库或密钥。

## 日常使用

1. 双击 `D:\Apps\实时会议助手-STT-CPU\启动CPU语音服务.bat`。看到 `listening ws://127.0.0.1:6006 ... provider=cpu` 后，保留此窗口。
2. 打开桌面快捷方式「实时会议助手（桌面预览）」，点击「麦克风录音」，允许 Windows 和应用使用麦克风。
3. 暂停会释放设备；继续会重新取得设备，并使用当前仍连接的识别通道。结束后原文入库。关闭桌面会清理它自己的 Node 后台。
4. 不再使用语音服务时，在服务窗口按 Ctrl+C；已实测该启动入口能够释放监听端口并退出。它是用户手动启动的独立服务，桌面不会接管或终止它，没有隐藏托盘常驻。

服务只监听回环地址；6006 已被其他进程占用时启动脚本明确拒绝，不停止或接管现有进程。另选端口时，在服务启动参数和桌面 `STT_WS_URL` 同时修改。

语音服务拒绝带浏览器 Origin 的直接 WS 连接，页面需通过应用后端访问；不带 Origin 的本地 Node/命令行客户端仍可使用。此限制不隔离同一用户的其他本机进程，没有引入账号系统。

本机桌面用户配置位于 `%LOCALAPPDATA%\RCC-Desktop-Preview\.env`；本轮只将语音设为真实模式：

```dotenv
MOCK_STT=false
STT_WS_URL=ws://127.0.0.1:6006
STT_SAMPLE_RATE=16000
```

问答与 embedding 保持原来的模拟配置；没有调用付费服务。真实 STT 不等于导图、摘要、问答都已使用真实模型。当前 MockLLM 的导图生成面向演示讲稿，真实转写可能不产生导图节点；其内容质量不属于本轮 STT 验收。旧安装版和源码 `.env` 未改动。

服务未启动时，桌面仍能打开；点击麦克风会先提示通道未就绪，再决定是否请求设备。安装目录缺少模型的日志只表示包内文件情况，实际外部服务是否可用以就绪检查为准。

## 开发与重复安装

在仓库根目录执行，默认安装到上述 D 盘目录。setup 是显式下载命令；模型运行时不自动联网下载。

```powershell
npm run setup:stt-cpu
powershell.exe -NoProfile -File tools/enable-stt-cpu.ps1
```

`setup-stt-cpu.ps1` 使用 uv 创建独立 Python 3.12 环境；可用 `-Python <已有解释器绝对路径>` 指定本机解释器。模型文件已存在且校验一致时复用；不修改全局 Python 包，重复 setup 保留 `stt-cpu.json`。配置启用脚本先备份桌面用户 `.env`，只更新三个 STT 字段，保留其他设置。旧桌面数据不迁移。

验证命令：

```powershell
& "D:\Apps\实时会议助手-STT-CPU\.venv\Scripts\python.exe" -X utf8 -m unittest discover -s services/stt-worker/tests -v
& "D:\Apps\实时会议助手-STT-CPU\.venv\Scripts\python.exe" -X utf8 tools/benchmark_stt_cpu.py --output outputs/stt-cpu-benchmark.json
node tools/verify-stt-cpu.mjs --work=<全新测试目录>
```

最后一项使用已安装的实际 Electron 页面、独立测试配置和数据库，以及 Chromium 原生文件虚拟麦克风；真实识别器运行在 D 盘独立 CPU 环境。权限由测试驱动选择，没有替换 MediaStream、AudioContext 或识别器，也没有关闭桌面安全设置。测试只清理它自己创建的服务与桌面后台。

## 本轮修复与性能记录

- **修复文件重采样比例**：8 kHz → 16 kHz 原来截短，48 kHz → 16 kHz 原来越界。修复后保持音频时长与样本插值；5 项 Python 测试通过。该函数用于文件自测，不替代前端 AudioWorklet。
- **修复停止时句尾缺字**：真实样例 `1.wav` 原结果止于“ALWAYS ALWAYS什么”，加入上游在线解码示例采用的 0.66 秒右侧上下文后输出“ALWAYS ALWAYS什么意思啊”。补齐的静音只供解码，不计入已接收音频的时间轴。[上游示例](https://github.com/k2-fsa/sherpa-onnx/blob/master/python-api-examples/online-decode-files.py)
- **修复就绪阶段断线释放**：将 ready 发送纳入 finally 释放范围，避免客户端在握手阶段离开后单客户端槽位残留。真实 worker 的连续连接/断开与 busy 拒绝测试通过。
- **CPU 参数选择**：i5-14400F、16 GB RAM；5 个上游语音文件、每档 3 轮，共 45 次真实解码。以下 RTF 是解码时间 / 音频时长，不含模型加载，不是字幕延迟或准确率。

| 线程 | RTF 中位数 | 最大 RTF | 模型加载时间 |
|---:|---:|---:|---:|
| 1 | 0.0577 | 0.0616 | 1.220 s |
| 2 | 0.0479 | 0.0536 | 1.357 s |
| 4 | 0.0476 | 0.0552 | 1.286 s |

2 与 4 线程的结果接近，选择 2 线程以减少并发线程数；没有声称 2 线程准确率更高或在所有机器上更快。2 线程在这些短样例中的解码速度约为音频时长的 21 倍。桌面固定语音链路的首次 partial 在开始上传后约 **1320 ms** 到达，仅是本次测量。

## 已验证与未覆盖范围

源码按先构建 shared 的顺序完成类型检查、lint、构建与 Node 回归；43 文件、321 测试通过。lint 退出码 0，仍保留旧探针文件的 12 warning / 1 info。Python 5 项测试另行执行。

真实 CPU 固定语音链路检查涵盖：worker 协议/CPU、真实 partial/final、单客户端拒绝、停止保留句尾、ready 周边断线、已安装桌面采集/上传、暂停释放、继续复用、转写入库导出、正常退出及独立服务继续可用；并增加真实 worker 拒绝陌生网页 Origin 的检查。最终数量和结果见 `outputs/stt-cpu-20261023/real-stt-verification.json`；安装包/旁路更新的结果见同目录 `verification.json` 和 `side-install-verification.json`。

最终结果：真实 CPU 链路 **13 项**、新版核心安装回归 **34 项**通过；实际旁路预览更新为 `0.1.0-desktop-preview.3`。安装重装保留配置和数据库，其他模型设置不变，实际用户配置的 STT 预检查就绪；未请求实际硬件。旧安装/旧快捷方式与设计原型哈希不变。测试所创建的 Python 服务和 Node 后台均已退出。

本轮识别结果仍有重复字及英文识别差异，没有标准逐字标注语料，因此**没有中文错误率或“识别准确”验收结论**。没有实际硬件权限、无设备/占用、十分钟真人讲话、长时间稳定性或真实 LLM/embedding 验收。本轮不关闭 M1/I01/I14，也不关闭会话恢复、断线缺口、失败补建等其他问题。
