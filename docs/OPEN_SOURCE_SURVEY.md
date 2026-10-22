# OPEN_SOURCE_SURVEY — Phase 0 开源生态侦察报告

> 项目：实时 STT + MindMap + 并行 AI 问答（Real-time Cognitive Companion）
> 侦察日期：2026-10-16 ｜ 原则：Open-source First, Architecture Controlled
> 状态：STT / VAD / Audio 已完成；MindMap、Embedding、LLM/Backend 章节由并行侦察任务补全。

---

## 0. 目标机器实测环境（所有选型的一票否决约束）

Phase 0 开始前已在目标机实测确认，非推测：

| 项 | 实测值 | 对选型的约束 |
|---|---|---|
| OS | Windows 11 x64 (10.0.26200) | 需 win_amd64 wheel / 二进制 |
| GPU | **Intel Iris Xe 核显，无 CUDA**（另有 GameViewer/MuMu 虚拟显卡） | 排除一切 GPU-依赖推理；只能 CPU |
| RAM | 15.8 GB | 模型常驻内存预算需 < 4 GB |
| Node | v24.18.1 | 内置 `node:sqlite` 可用（已实测） |
| Python | 3.14（`py -0p`），另有 uv 托管 3.11.15 / 3.12.13 | torch 生态无 3.14 wheel，需 uv 侧环境 |
| uv | 0.12.1 | 可按需拉起 3.11/3.12 隔离环境 |
| Docker | **不存在** | 禁止 Level-4 Docker 依赖 |
| ffmpeg | 8.1.2 (gyan.dev full build) | 音频格式转换可用 |

实测记录：
- `node:sqlite` `DatabaseSync` 在 Node 24.18.1 可建表、可批量插入 2000 行无异常。
- `sherpa-onnx` PyPI 最新 1.13.8，**win_amd64 wheel 覆盖 cp37–cp314（含 3.14）**，即当前 Python 版本无需降级即可安装。
- sherpa-onnx `asr-models` release 共 498 个资产，流式中文模型可下载（见下）。
- **已实机验证（非纸面）**：在本机用 Python 3.14 建 venv 并 `pip install sherpa-onnx` → **`import sherpa_onnx` 成功，`OnlineRecognizer` 存在**。cp314 wheel 不只是"列表里有"，而是真的能跑。
- ⚠️ **网络实测风险**：安装过程中 `pypi.org/simple/` 多次 `ReadTimeout (timeout=15)` 并触发 pip 自动重试；`huggingface.co` 与 `github.com` HTML 从本机 curl 不可达（仅 `api.github.com`、PyPI JSON API、GitHub release 资产可达）。这直接影响 Phase 0 之后的依赖安装与模型下载策略。

---

## 1. 本地 / 自托管流式 STT（CPU + Windows）

| 候选 | License（代码 / 模型） | 活跃度（实测 release） | partial+final 真流式 | 中文能力 | CPU 可行性 | 延迟与内存证据 | 接入方式 | 接入成本 | 替换成本 |
|---|---|---|---|---|---|---|---|---|---|
| **sherpa-onnx**（streaming Zipformer / streaming Paraformer） | **Apache-2.0** / Zipformer(icefall·WenetSpeech)、Paraformer、SenseVoice 均 **Apache-2.0** | v1.13.8 (2026-09-10)，repo pushed 2026-10-15，≈15.3k stars | **是**（`OnlineRecognizer` + endpointing） | 好（zh-en 双语；专用 2025 中文模型） | **是，为 onnxruntime/CPU 而生** | 第三方实测：Zipformer-INT8 在**树莓派 4B** RTF≈0.12（10s 音频 1.2s 完成），partial≈200–300ms；本机 x86 笔记本 CPU 更快（估算） | `pip sherpa-onnx`（有 cp314 win wheel）+ ~~自带 **`sherpa-onnx-online-websocket-server`** 二进制~~ + Node/Python/C# 绑定 | ~~**低–中**（现成 server，零 fork）~~ **中**（需自写薄 worker，见下方更正） | 低（纯 localhost WS JSON） |
| **FunASR / Paraformer-streaming**（`paraformer-zh-streaming` + `fsmn-vad`） | **MIT**（代码）/ ModelScope `iic` 模型 **Apache-2.0**（附署名要求的 Model License Agreement） | v1.4.16 (2026-09-18)，pushed 2026-10-16，≈20.7k stars | **是**（chunk `[5,10,5]` = **600ms** lookahead） | **优秀**（阿里普通话+方言+热词） | 可行但更重（依赖 torch） | 600ms chunk → partial≈0.6s（估算，达标 <1s）；220M 参数，加载 torch 后数 GB RAM | `pip funasr` 为 **sdist-only，无 Windows wheel** → 必须 uv 拉 3.11/3.12 + torch；runtime 走 WebSocket | **中–高**（环境/依赖） | 中 |
| **faster-whisper**（+ Whisper-Streaming / WhisperLiveKit） | **MIT** / ctranslate2 MIT / Whisper 权重 **MIT** | faster-whisper v1.2.1 (2025-10-31)；ctranslate2 4.8.3（win cp314 wheel 存在）；WhisperLiveKit ≈8.8k stars 活跃 | **原生否**（段级）；流式靠 wrapper 的 SimulStreaming/LocalAgreement | 尚可，zh 弱于 Paraformer（OpenAI 论文：large-v2 在 FLEURS zh WER≈14.7%） | 边缘可用，需 tiny/base/turbo | **Whisper-Streaming 文档延迟≈3.3s → 不满足 MVP <1s**；WhisperLiveKit CPU 建议 4 核跑 tiny/base，1.5–2× 实时 | pip；WhisperLiveKit 自带 WS server + React client，兼容 OpenAI/Deepgram API | 中（**延迟风险高**） | 低 |
| **whisper.cpp**（`whisper-streamed`） | **MIT** / 模型 MIT | v1.9.5 (2026-10-06)，pushed 2026-10-12，≈54k stars | 是，但**缓冲式段 interim**，非亚秒流式 | 同 Whisper 系 zh 局限 | 是（CPU 性能好），但不是低延迟流式端点 | RTF≈0.3（M 系 CPU）；`whisper-streamed`≈1–3s（估算） | C++ 二进制 + 社区 HTTP/WS server，需编译 `.bin` 模型 | 中 | 中 |
| **Vosk** | **Apache-2.0** / 模型 **Apache-2.0** | PyPI 0.3.45；repo pushed 2026-10 但最后 release **v0.3.50 (2024-04)** → **停滞** | **是** | **一般**（大模型 CER≈14%，small-cn 42MB 明显更差） | 是，极轻（42MB / 1.3GB） | ≈1.2× 实时（i5-8250U），≈150MB RAM | `pip vosk` / Node 绑定 | 低 | 低，但**质量+弃维护风险** |
| **NVIDIA NeMo Parakeet / Canary** | 代码 **Apache-2.0**；**Canary-1b 原始权重 = CC-BY-NC 4.0（研究专用，商用被禁）**；canary-1b-flash/v2、Parakeet = CC-BY-4.0 | 活跃 | RNN-T 流式 是 | **无中文**（en/de/fr/es/ja 为主） | CPU 不现实（面向 GPU/NIM） | — | NeMo Python（重）/ transcribe.cpp 等 ggml 移植 | 高 | **不可用** |

> ⚠️ **Phase 5 更正（2026-10-20，落地实跑后回填）**：sherpa-onnx 那一行"自带 `sherpa-onnx-online-websocket-server` 二进制、零 fork"的写法**查证不成立** —— GitHub release 资产里没有这个可直接运行的文件，`sherpa-onnx==1.13.8` 的 wheel 里 websocket 相关文件为 0，唯一 console script 是 `sherpa-onnx-cli`（还要额外装 `click`）。实际接入方式是：本仓库自写 `services/stt-worker/stt_worker.py`（约 300 行）调用未修改的公开 `OnlineRecognizer` API + `websockets`（BSD-3-Clause）做传输。这**不改变选型结论**（其余四条判据都成立），但把"接入成本"从"低–中"更正为"中"，并把"零二次开发"从证据清单里划掉。详见 `ARCHITECTURE_DECISION.md` §6.3 D-20、`THIRD_PARTY.md` 第 1/15/16 条。

关键来源：
- sherpa-onnx（Apache-2.0）https://github.com/k2-fsa/sherpa-onnx ｜ 模型尺寸 https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models
- FunASR https://github.com/modelscope/FunASR ｜ iic 模型许可 https://modelscope.cn/organization/iic
- Whisper-Streaming ≈3.3s https://github.com/ufal/whisper_streaming ｜ WhisperLiveKit https://github.com/QuentinFuxa/WhisperLiveKit
- Vosk 模型许可/尺寸 https://alphacephei.com/vosk/models ｜ Canary CC-BY-NC https://developer.nvidia.com/blog/new-standard-for-speech-recognition-and-translation-from-the-nvidia-nemo-canary-model/

### 1.1 已实测的模型下载清单（GitHub release，本机可下）

| 模型资产 | 体积 | 下载量 | 用途判断 |
|---|---|---|---|
| `streaming-zipformer-bilingual-zh-en-2023-02-20` | 511.3 MB | 670,159 | **主推**：中英双语流式，最久经考验 |
| `streaming-zipformer-zh-int8-2025-06-30` | 132.6 MB | 24,426 | 备选：2025 中文 INT8，内存友好 |
| `streaming-zipformer-zh-2025-06-30` | 594.1 MB | 7,408 | 中文高精度（体积大） |
| `streaming-zipformer-small-ctc-zh-int8-2025-04-01` | 21.3 MB | 9,653 | **CI / Mock 冒烟测试首选**（下载快） |
| `streaming-zipformer-small-bilingual-zh-en-2023-02-16` | 458.2 MB | 14,962 | 双语小模型 |
| `streaming-paraformer-bilingual-zh-en` | 1.05 GB | — | 中文更硬的场景 |

结论：**sherpa-onnx 是唯一同时满足「真流式 partial+final」+「CPU 实时」+「代码与模型双 Apache-2.0（商用干净）」+「有 cp314 Windows wheel」的选项**（原第 5 条「自带现成 WebSocket server，无需 fork/重写」**已被 Phase 5 证伪**，见上方更正——改为自写约 300 行薄 worker），且完全契合「重活作为独立本地进程 + Adapter 接入」的架构约束。

### 1.2 本机实测基准（不是引用别人的数字）

侦察报告里所有 CPU 延迟都是别种硬件的数据或估算。因此我在**目标机本身**跑了三段实测（模型：`streaming-zipformer-small-ctc-zh-int8-2025-04-01`，21.3 MB，4 线程，8 逻辑核）：

| 指标 | 实测值 | 对 MVP 的意义 |
|---|---|---|
| RTF（墙钟/音频） | **0.034–0.037**，即 **27× 实时** | 算力余量巨大 → 可以换更大的双语模型而不失速 |
| 每 100ms 音频块的解码耗时 | p50 **0.15ms** / p95 **21–24ms** / max **42–103ms** | 单块最坏 103ms，仍远小于 100ms 预算的 2 倍，不会堆积 |
| **实时节奏下的积压** `lag` | 53s 会话 p95 **−79ms**（始终领先）；97s 会话 max **+7.2ms** | 解码速度跟得上实时输入，字幕延迟由模型 lookahead 决定，不由算力决定 |
| **首个 partial 出现时间** | **0.73s / 0.74s**（两次独立运行一致） | ✅ **直接满足 MVP「partial 字幕 < 1 秒」验收指标** |
| 长跑内存（等效 **46 分钟**音频，RSS 采样） | 126,284 KB → 126,352 KB，**增长 68 KB** | ✅ 流式 cache 定长，**实测无泄漏**，关闭 Test F 的内存风险 |
| 进程总 RSS（含 Python+onnxruntime+模型） | ≈ **126 MB** | 16GB 机器上余量充足 |
| 中文识别质量 | 正确输出「对我做了介绍那么我想说的是呢大家如果对我的研究感兴趣呢重点呢想谈三个问题…」 | 准确率可用 |

⚠️ **实测发现的新问题（原设计文档未考虑）：流式 CTC 模型输出没有标点。**
影响：① 字幕可读性差；② 送给 MindMap / QA LLM 的文本缺少句子边界，节点切分与检索质量下降。
处置选项（Phase 5 前需决定）：
1. 加一个标点恢复模型（FunASR CT-Transformer，或 sherpa-onnx 侧后处理）——增加 Python 依赖；
2. 用 LLM 在 MindMap/Summary 阶段顺带补标点（零额外模型，但 final 文本与字幕不一致）；
3. 接受无标点（最省，体验最差）。
→ 记入 ARCHITECTURE_DECISION 为待决项 **ADR-OPEN-1**。

另注：本测试用重复音频，端点(rule1/2/3)触发频率不能代表真实演讲，端点参数需 Phase 5 用真实音频调。


## 2. 云流式 STT（作为 fallback）

| Provider | ToS / 使用约束 | 已查证价格 | interim 结果 | 中文 | 延迟宣称 | SDK 成熟度 |
|---|---|---|---|---|---|---|
| **阿里 DashScope Paraformer-realtime-v2** | 音频出境至阿里云（合规/数据驻留需标记） | **¥0.00024/s ≈ ¥0.0144/min ≈ $0.12/hr** | 是（WS，边说边出） | **最佳**（普通话+方言+热词） | 「稳定低延迟」（无 ms 数值） | DashScope SDK(Py/Java) + OpenAI 兼容 WS |
| **Azure AI Speech** | 微软 SaaS；F0 并发=1 | **$1/hr 实时（≈$0.017/min）；F0 免费 5 音频小时/月** | 是（interim+final） | **强** zh + 方言 | 毫秒级（无固定值） | 非常成熟(JS/Python/C#) |
| **Deepgram Nova-3** | SaaS，默认不用你的音频训练；$200 赠额 | ≈$0.0043–0.0125/min（需实时核对）；RTF≈0.08 | 是（`interimResults` + keyterm） | **弱点**：zh 不在实时 10 语种码切换表内，流式不支持语言检测 | interim <300ms | 成熟(Node/Python/Go) |
| **AssemblyAI Universal-Streaming** | SaaS | **$0.15/hr**，并发不限 | 是 | 支持 | 低 | 成熟 |
| **Soniox** | SaaS | **$0.12/hr 流式**（异步 $0.10/hr） | 是（token 级） | 支持 40+ 语种 | partial 很快 | 有 SDK |
| **Gladia Solaria** | SaaS | ≈$0.61/hr | 是 | 支持 | — | Node/Python |
| **OpenAI Realtime / gpt-4o-transcribe** | SaaS | gpt-4o-transcribe **$0.006/min($0.36/hr)**，mini $0.003/min | 是 | 支持但 Whisper 系 zh WER≈14.7% | 低 | 非常成熟 |
| **Google Cloud STT** | GCP | ≈$0.016/min（v1 std） | 是 | **强** zh-CN | ≈300ms 级 | 成熟 |

**Fallback 排序**：DashScope Paraformer-realtime-v2（中文最好最便宜）→ Azure AI Speech（SDK 成熟 + 每月 5 小时免费）。Deepgram 仅在英文为主时用。

---

## 3. VAD 与音频采集

| 候选 | License（代码/模型） | 活跃度 | ONNX / 浏览器 | 判断 |
|---|---|---|---|---|
| **Silero VAD** | **MIT（代码+模型均 MIT）** | v6.2.3 (2026-09-23) | ONNX 内置；可跑 `onnxruntime`(Py) 或 **`onnxruntime-web` WASM（浏览器）**；npm `@ricky0123/vad-web`(MIT, 内含 `silero_vad_v5.onnx`) | ≈260k 参数，单 CPU 线程每 30ms 块 **<1ms**。已是 sherpa-onnx / faster-whisper(`vad_filter`) / WhisperLiveKit 的默认 VAD |
| **WebRTC VAD** | BSD-3 | `py-webrtcvad` 停滞、无 3.14 wheel | C 库，浏览器原生 | 更小更快但**精度低于 Silero**，仅用于麦克风门控 |
| **FSMN-VAD**（FunASR） | Apache-2.0 / Model License | 随 FunASR 活跃 | 仅 Python | 与 paraformer-zh-streaming 天然配套 |

**放置决策：VAD 归后端。** 理由：VAD 决定 final 段边界与 MindMap 节点边界，必须与 ASR 流共享同一权威源。浏览器侧可选跑一个轻量 Silero（`vad-web`）**仅用于门控上行音频与显示音量条**，但不得作为权威——它与 UI 渲染争抢主线程，且 2 小时会话会漂移。

浏览器音频采集：`MediaRecorder` 不能直接给 PCM 流；需 **AudioWorklet** 采集 Float32 → 降采样至 16 kHz → Int16 PCM 分块经 WebSocket 上行。这是标准做法，无重型第三方依赖（VAD 之外）。

---

## 4. 排除清单（License / 硬件一票否决）

| 被排除 | 原因 | 复活条件 |
|---|---|---|
| NVIDIA Canary-1b（原始权重） | **CC-BY-NC 4.0 研究专用，商用禁止**；且无中文、面向 GPU | 永不（除非换 CC-BY-4.0 的 flash/v2 且只做英文） |
| Whisper 系作为**主** STT | 文档化 partial 延迟≈3.3s，**不满足 MVP <1s**；zh 弱 | 仅作「离线高精度重转」旁路 |
| 任何 Docker Level-4 依赖 | 目标机无 Docker | — |
| 任何 CUDA-only 推理 | 仅 Intel Iris Xe | — |
| pyannote（若仅调研） | 代码 MIT 但模型许可受限 + CPU 重 | 见 §7 说话人分离 |
| Kafka / RabbitMQ / Redis Streams | 文档 §17 明令禁止，模块化≠微服务化 | 永不（MVP） |

---

## 5. LLM 抽象层（Node/TypeScript）

> 版本与 License 均来自 npm registry / LICENSE 实测。**注意：AI SDK 当前是 v7（不是 v5/v6）**；v6 起结构化输出已从 `generateObject` 迁移到 `generateText`/`streamText` + `Output.object({schema})`。

| 候选 | 版本 / License | 流式 | 严格 JSON Schema | Provider 无关接缝（Adapter 契合度） | retry / timeout / abort | TS 质量 | 接入成本 | 判断 |
|---|---|---|---|---|---|---|---|---|
| **Vercel AI SDK** `ai` | 7.0.142 / **Apache-2.0**（`@ai-sdk/openai-compatible@3.0.70`） | ✅ `partialOutputStream` 流式半成品 JSON | ✅ `Output.object` + Zod，映射各家原生 strict | **最佳**：统一 `LanguageModel` 接口，`openai-compatible` 直接指向 DeepSeek/Qwen/GLM/Kimi 的 base_url；**mock 就是一个自定义 provider** | `abortSignal` / `stopWhen` / total+per-step timeout / 内建 `maxRetries`+退避 / `onFinish({usage})` | 优秀 | 中（v6→v7 有 churn） | 想要「流式 UI + 接缝 + 结构化输出」三合一时的首选 |
| **OpenAI SDK** `openai` | 7.34.0 / **Apache-2.0** | ✅ SSE | ✅ Structured Outputs `json_schema strict:true` + `zodResponseFormat` | 薄但够用：四家国产 provider 都提供 OpenAI 兼容 `/v1` → **一个 client + 换 baseURL/model 即 Adapter** | 原生 `maxRetries` / `timeout` / AbortController | 优秀 | **最低** | **MVP 最简路线** |
| **Anthropic SDK** | 0.135.0 / **MIT** | ✅ | 仅靠强制 tool use（无 `json_schema` strict 参数） | 需额外分支 | `maxRetries`(默认2)/timeout/abort | 优秀 | 中 | 仅当正式选 Claude 时用 |
| **Google GenAI** `@google/genai` | 2.30.0 / **Apache-2.0** | ✅ | ✅ `responseSchema`+`responseMimeType`（语法约束，可靠） | Gemini 专用接缝 | ✅ | 好 | 中 | 免费额度可用，结构化最可靠之一 |
| **LiteLLM** | 1.105.1 / **MIT 核心（`enterprise/` 目录为商业授权）** | ✅(Py) | ✅ | Python 侧或自建代理 → 与「Node 主栈」矛盾 | 代理层 | TS 无 | 高 | MVP 跳过：1 个 provider 时代理是纯增负担 |
| **new-api** | — / **AGPL-3.0 + 去品牌需商业授权（双许可）** | relay | ✅ | 需额外部署 Go 服务 | — | — | 高 | ⚠️ **License 风险，避免**（文档 §9 要求单独标记） |
| **one-api** | — / **MIT**（实测 LICENSE 文本为 MIT，非 AGPL） | relay | ✅ | 额外服务 | — | — | — | 1 provider 时不需要 |
| **LangChain / LangGraph** | 1.5.18 / `@langchain/langgraph` 1.5.0 / **MIT** | ✅ | `with_structured_output` | 抽象过重 | `with_fallbacks` | 概念负担大 | **高** | ❌ **建议不用**：与文档 §19「非必要不引入复杂 Agent Framework」直接冲突；线性单次流程用它属杀鸡用牛刀，且 breaking change 频繁 |

**Adapter 结论**：DeepSeek / Qwen(DashScope) / GLM(Z.ai) / Kimi 全部暴露 **OpenAI 兼容 `/v1`**。最轻且正确的做法 = 核心定义 `LLMProvider` 接口 → 一个 OpenAI-SDK 实现（正式）+ 一个 mock 实现，换 provider 只改 `baseURL + apiKey + model`。若要结构化流式与统一 usage/retry，则用 **AI SDK v7 + `@ai-sdk/openai-compatible`**，mock 注册为自定义 provider。两条路都把第三方 schema 关在 Adapter 后面。

---

## 6. LLM 模型选型（⚠️ 价格需官网复核）

> **重要声明**：官方定价页（openai.com / anthropic.com / ai.google.dev / api-docs.deepseek.com）在本机 WebFetch **不可达**，下表价格取自引用官方页的二手来源并做了 ≥2 处交叉，且部分为**限时促销**。预算前必须以官网为准。此处只用于**相对量级判断**。

| 模型 | 输入/输出 价格量级（需复核） | 严格 schema | 中文 | TTFT 特征 | 测试成本 |
|---|---|---|---|---|---|
| **Qwen3.7/3.8-Flash**（DashScope） | 最低档（$0.03–0.15 / $0.13–0.47 量级） | 🔴 **实测（2026-10-21）：`json_schema` strict 不可用**，端点回 `This response_format type is unavailable now`，只有 `json_object`。本行原写"✅ 支持真 strict `json_schema`"是 Phase 0 的二手印象，已被真调用证否（ADR §6.5 D-31） | 原生优秀 | Flash 档 TTFT 低 | **有免费额度 → 最便宜的测试路径** |
| Qwen3.7-Plus / Max | 中 / 高 | 🔴 同上：同一个专属实例上 strict 不可用（`qwen3.8-max` 已实测） | 优秀 | — | 需 key |
| **deepseek-flash / v4-pro** | 极低（有峰谷价，官方预告涨价） | ❌ **仅 JSON mode，无原生 json_schema strict**（需函数调用）——与本轮实测一致：`deepseek-v4.1-flash` 走的仍是 `json_object` | 原生强 | 快、1M ctx | 很便宜 |
| **GLM-5.3-FlashX / GLM-4.7-Flash** | 低 / 有免费档 | JSON mode | 原生强 | **~200 tok/s，实时调优** | 可免费试。🔴 实测：`glm-5.3` **拒绝 `enable_thinking:false`**，所以本项目默认发的那个键换到它身上会把请求直接打失败（要设 `LLM_DISABLE_THINKING=false`） |
| Kimi K2.6 | 中 / 偏高 | ✅ JSON Schema | 强 | 好 | 输出偏贵 |
| **Kimi K3** | 中 | ✅ strict（**未在本端点验证**） | 优秀 | ⚠️ **thinking-only，TTFT≈3.56s** | ❌ **QA 场景超预算**；🔴 实测：它**拒绝 `temperature=0.2`**，而导图与 QA 两条路径都在发这个数 |
| GPT-5.6/6 Luna | 低 | ✅ Structured Outputs strict | 好（非中文优先） | Luna 最快档 | 无免费额度 |
| Claude Haiku 5.5 | 低 | 强制 tool use | 好 | **最快最省的 Claude 档** | 需 key |
| Gemini 3.x Flash | 中（促销价有到期日） | ✅ responseSchema 语法约束 | 好，持续改善 | Flash 低 TTFT | AI Studio 免费层 |

> **2026-10-21 的实测口径**（ADR §6.5 D-31）：上面标 🔴 的四行来自同一个 DashScope 专属实例（`/models` 列出 178 个模型），**不是各家的官方端点**——所以"逐厂 strict 支持程度"这一半的账只还了一半。另外两条新事实：① 开着思考的同类调用实测 **27–106 s**，会顶穿 `LLM_TIMEOUT_MS=30000`，所以"禁用 thinking-only 跑 QA"从经验法则变成配置约束（`LLM_DISABLE_THINKING` 默认 `true`）；② **R1 系（`deepseek-r1-distill-qwen-1.5b`）是分路径合格的**：流式问答可用（含 4 条真实引用），结构化在 `max_tokens 1200` + 30 s 下不合格（`content` 为空 → 校验报 `received null`）。想用 R1 必须同时抬 `max_tokens` 与超时，而 `enable_thinking:false` 对这类"必须思考"的模型无效。

**MVP 选择**：正式 Provider = **DashScope Qwen-Flash/Plus**（中文原生 + OpenAI 兼容 + 有免费额度 → Adapter 最省事）；Mock Provider 一个。⚠️ 原这一行还写着"真 strict schema"作为理由，**该理由已于 2026-10-21 实测证否**，形状保证因此完全落在我们自己的两层 Zod + 四道闸上（ADR §7 / §12 R2）。
**明确规避**：thinking-only / 强制思考模型（Kimi K3、GLM-5.3 强制 thinking）用于 QA 流式路径 —— 会打穿 <3s TTFT 预算；此类模型只可用于非实时的 MindMap 路径。
**DeepSeek 若选**：必须自带 Zod 校验 + repair 重试（无论选谁，这道闸都必须存在，见 §10 风险）。

---

## 7. Event Bus、CPU 卸载与说话人分离

### 7.1 进程内 Event Bus

| 候选 | 版本 / License | 关键行为 | 判断 |
|---|---|---|---|
| **emittery** | 2.1.0 / **MIT**（engines ≥22） | **监听器抛错不会中断其他监听器**（全部跑完，错误聚合进 `AggregateError`）；`events()/anyEvent()` 提供 async iterator；订阅支持 AbortSignal | ✅ **最契合「故障隔离」硬要求** |
| Node 内置 `EventEmitter` | 内置 | **同步 emit**：抛错会中断后续监听器；未处理的 `'error'` **直接让进程崩溃** | 需自己包 per-listener try/catch，反而是核心代码 |
| mitt 3.0.1 (MIT) / mqemitter 7.1.0 (ISC) / RxJS 7.8.2 (Apache-2.0) | — | 前者无隔离；mqemitter 是 MQTT 风格偏重；RxJS 能力强但对 4 模块总线是过度设计 | 不选 |

**类型安全**：用映射类型 `interface BusEvents { 'transcript.final': {...}; 'mindmap.tick': void }` + 一层 `emit<K extends keyof BusEvents>()` 泛型包装（emittery 只给事件名类型，不给 payload 类型）。
**故障隔离模式（承重部分）**：① 模块间只经总线通信，禁止直调 → MindMap 卡死不会反压 STT；② 订阅体 try/catch + `.catch()`，失败即 emit `mindmap.failed` 并 return；③ MindMap 用 `inFlight` 标志实现 single-flight，**忙时跳过而非排队**（有界，不堆积）；④ 每次 LLM 调用带 AbortController 超时，abort 后标记 graph stale 等下个 tick；⑤ 兜底 `process.on('unhandledRejection')` 记日志。

### 7.2 CPU 卸载

- `worker_threads`：独立 V8+libuv，适合进程内 CPU 密集（embedding 推理、长文本 diff）。
- `child_process`：独立 OS 进程，**崩溃不带走父进程**。
- **决策**：凡涉及**原生 addon（onnxruntime-node / sqlite-vec）一律走 child_process 或 localhost WS**，因为原生调用 segfault 在 worker 里会**整个进程一起死**，这与「一个模块失败不得拖垮系统」直接冲突。Python STT worker 已天然是这个边界。
- `node:sqlite` 写入是同步的：重写入不要放在请求路径上；STT 路径是 I/O 异步，留在主 loop 无妨。

### 7.3 说话人分离（调研即止，确认延后正确）

pyannote.audio 代码 **MIT**（LICENSE 实测 "MIT License © 2020 CNRS"），但**预训练模型在 HuggingFace 上是 gated**（需登录+接受条款+Write token），而本机 **HF 不可达** → 直接卡死；且依赖 PyTorch，在无 CUDA 的 Iris Xe 上只能离线批处理。
**结论**：延后是正确决定。若将来需要，应在**已选定的 sherpa-onnx Python worker** 内用 CAM++/3D-Speaker（Apache-2.0、ONNX/CPU、无 HF gated）做批处理，不进实时 Node 回路。

---

## 8. MindMap 渲染器与布局引擎

本项目最难的非功能需求是「**增量更新时已有节点不许重排**」（设计文档 §18/§25 + 验收 Test B）。因此选型以「能否结构性保证坐标稳定」为第一判据，功能多寡为次。

### 8.1 渲染器对比（版本/License 实测自 npm registry + LICENSE 文件）

| 候选 | License | 最新稳定版 + 活跃度 | React 集成 | **坐标稳定性** | 性能证据 | 包体(gz) | 接入成本 |
|---|---|---|---|---|---|---|---|
| **React Flow `@xyflow/react`** | **MIT** | 12.12.0 (npm 2026-09-24)，pushed 2026-10-15，38.7k★ | 本身就是 React 库，一等 TS | ✅ **结构性满足**：**无内置自动布局**，`position` 必由调用方提供，除你的代码外没有任何东西会移动节点 | DOM/SVG；官方 `onlyRenderVisibleElements` + `hidden` 折叠子树；社区估 >200 节点未调优会退化（**估算，需本机压测**）→ **该估算已于 2026-10-20 在本机被证否**：无头 Edge + CDP 实测 1163 节点，缩放/平移/空转 455 帧 p50=p95=p99=17 ms、>50 ms 帧 0 次；退化不在交互帧率，而在"每批重建全部节点对象导致新节点 18–362 ms 才上屏"（ADR §6.2 D-26） | 183.5KB / **58.6KB** | 中 |
| **Cytoscape.js** | **MIT** | 3.34.4 (npm 2026-10-15)，11.2k★ | 包装器 `react-cytoscapejs` **2022 年冻结**，需 ref 命令式管理 | 部分：位置按元素持久，`layout:{name:'null'/'preset'}` 可保留；**但惯用法"跑个 layout"会全部重排** | Canvas，社区实测 ~5000 节点（**真实数据点**） | ~130KB(gz 估) | 高 |
| **AntV G6 v5** | **MIT** | 5.1.1 GA (npm 2026-05-08)，pushed 2026-10-16，12.3k★，**335 open** | `@antv/g6-extension-react` 渲染 DOM 节点 | 部分：`addData` 增量，但 layout 调用时仍重排；靠 `fx/fy` 钉住 | Canvas，数千节点（估） | 大(估>400KB) | 高（v5 是 v4 的重写，文档中文优先） |
| vis-network | dual MIT/Apache-2.0 | 10.1.2 (2026-08-19)，**351 open** | 仅社区包装 | 部分：物理引擎加节点会重仿真，除非 `physics:{enabled:false}` 或 `fixed:true` | ~1k（估） | 115.6KB | 低–中 |
| Konva / react-konva | MIT | 10.9.0 / 19.3.2（均 2026-10-15） | 好 | 完全自持坐标，**但零图语义**（边/缩放/折叠全要自建） | 优秀 | 55+43.6KB | 极高 |
| PixiJS | MIT | 8.22.0，48.4k★ | `@pixi/react` | 原始自持，零图语义 | WebGL 最强 | **258.6KB** | 极高 |
| D3 (+自建 SVG) | ISC | 7.9.0 | 无，需自封装 | 自持即可；`d3-hierarchy` 确定性 | 同 React Flow | 全量 280KB，仅需 d3-hierarchy **14KB** | 极高 |
| jsMind | BSD-3-Clause | 0.9.1 | 无官方 | ❌ **库自己拥有模型，增删折叠即重排整棵树** | 一般 | 小 | 低 |
| Mind Elixir | MIT | ⚠️ `latest` = **6.0.0-next.4（预发布当 latest）** | 社区 | ❌ 自持布局 | 好 | 27.3KB | 低 |
| simple-mind-map | MIT | ⚠️ `latest` = **0.14.0-fix.3（hotfix 当 latest）** | 框架无关 | ❌ 自持布局 | 好 | 92.6KB | 低–中 |
| markmap | MIT | 0.18.12 (2025-06) | 需自接 `markmap-view` | ❌ markdown→树，每次 `setData()` **重跑完整 d3-flextree 布局**；且无法消费我们的 add/move/merge 操作（md 往返有损） | ~1k（估） | 拉入 d3+markdown-it | 低 |
| mermaid | MIT | 12.2.0，90.7k★，**1894 open** | 渲染成 DOM | ❌ 静态 text→SVG，整体重绘，非实时交互编辑器 | n/a | 169.5KB | 低 |
| **GoJS** | ⚠️ **商业，非开源** | 4.0.5 | 好 | 技术上很强（增量 TreeLayout） | 优秀 | 大 | **License 阻断**：无 key 带水印，≈$3,995/开发者 |
| **tldraw** | ⚠️ **source-available，禁止生产使用** | 5.5.2 (2026-10-02) | React 原生 | 坐标自持但**无图/导图布局** | — | 极大 | **License 阻断**（LICENSE.md 明写 "Not to use in Production Environments"） |

**License 红旗（实测，非推测）**：`elkjs` = **EPL-2.0 OR GPL-3.0-or-later**（弱著作权，商业需评审）；`gojs` 商业付费；`tldraw` 禁生产；其余（React Flow / Cytoscape / G6 / vis / Konva / Pixi / D3 / jsMind / markmap / mermaid）均为 MIT/ISC/Apache/BSD 宽松。

### 8.2 布局引擎对比（重点：真增量 vs 假增量）

| 引擎 | License | 版本 + 发布日 | **是否保留已有坐标** | 确定性 | 包体 | 同步/异步 |
|---|---|---|---|---|---|---|
| **dagre** | MIT | 0.8.5 — **最后发布 2019-12-03，冻结约 7 年** | ❌ **否**：`layout()` 覆写每个节点 x/y，无 fixed-position 概念；业界"保留位置"的做法是**忽略 dagre 对已放置节点的输出** | ✅ | 284KB（内含 graphlib+lodash） | 同步 |
| graphlib | MIT | 2.1.8 (2019) | 仅数据结构，无布局 | n/a | 26KB | 同步 |
| **elkjs (ELK)** | **EPL-2.0 / GPL-3.0** | 0.12.0 (npm 2026-07-17) | 部分且笨拙：README 承认"参考上次布局结果/增量加节点"是长期未解 issue（#100、elk#355、elk#627），**没有干净的一键增量 API**；博客里流行的 `elk.incremental` **不是真实选项** | ✅（layered） | **1417KB min / 423KB gz**（GWT 转译 Java） | 异步，**原生支持 Web Worker** |
| d3-force | ISC | 3.0.0 | ❌ 力导向天生不稳定，加节点必挤动旧节点，除非 `fx/fy` 全钉 | ❌ **不确定** | 15/5.5KB | 异步 tick |
| **d3-hierarchy**(`tree`/`cluster`/`radial`) | ISC | 3.1.2（2022 起稳定） | ⚠️ 整体调用会重算全部；但**作为纯函数只对新子树调用、并把子树根钉住**即可 —— 这正是"局部分支 tidy"的最佳工具 | ✅ **完全确定** | **14/5.5KB** | 同步 |
| cytoscape-fcose | MIT | 2.2.0 (2023-01-17) | ✅ 支持 `fixedNodeConstraint`：钉住旧节点、只让新节点落位 —— 力导向里最接近真增量 | ~（力导向） | 扩展 | 异步 |
| cose-bilkent | MIT | 4.1.0（**2019-09，旧**） | 重排，本身无钉住概念 | ~ | 扩展 | 异步 |
| dagre-d3-es | MIT | 7.0.14（45★，**采用率低**） | 同 dagre，无增量 | ✅ | 模块化较小 | 同步 |

### 8.3 推荐组合与**可实现模式**（本节为决策核心）

> **渲染：React Flow v12（MIT）。布局：自己拥有坐标 + 仅对新子树跑 `d3-hierarchy`（把 ELK 降级为"显式全局重排"的可选 Worker 路径）。**

React Flow 胜出的理由是结构性的：它**没有内置布局引擎**，节点坐标就是你塞进 `position` 的值，没有任何内部机制会重算它 —— 需求「加一个节点不许动其他节点」不是靠搏斗得来的，而是默认成立。`parentId`/`extent:'parent'`、可拖拽、`hidden`、`onlyRenderVisibleElements`、真实 DOM 自定义节点覆盖了其余需求。Zustand 恰是 React Flow 官方推荐的 store 模式。

可实现模式（业界公认做法 = 按 id 缓存坐标 + 只布局新子树 + 钉住子树根）：

1. **内容与布局分离**。Zustand 存：`byId`（规范节点）+ 独立的 `positions: Record<id,{x,y}>` 缓存 + `childOrder[parent][]`（按 `createdAt` 再 `id` 排序以保证确定性）+ `collapsed:Set` + `childCursor:Record<parent,number>`（该父节点已用到的下一个 y 偏移）+ `pinned:Set`（用户拖拽覆盖）。React Flow 节点由 `useMemo` 派生：`position = positions[id]`。所有操作走**一个纯函数 reducer `applyOp(state, op)`**。
2. **`add_node` = 纯追加，零重排**。只算新节点坐标：`x = parent.x + parentW + H_GAP`；`y = parent.y + childCursor[parent]`，随后 `childCursor[parent] += newH + V_GAP`。**绝不触碰 `positions` 里的任何已有条目**。
3. **只布局子树并钉住其根**。某分支失衡或用户展开折叠节点时，对该节点的**后代**单独跑 `d3-hierarchy.tree()`（用 React Flow 实测宽高），再把结果**整体平移使子树根保持缓存坐标**，只回写子树内节点。图其余部分**可证明未被触碰**。确定性、14KB、同步 —— 每次操作都跑得起。
4. **`move_node`/`merge_node`/`delete_node` 全部子树局部**。改父指针后只 tidy 被移动的那条分支；merge 保留目标坐标并把源子节点重指向目标；delete 从 `positions` 移除留空位（或仅 tidy 该父的其余子节点）。任何操作都不触发全局布局。
5. **全局重排是显式且低频的**。只作为"整理整图"手动动作，在 **Web Worker** 里跑 ELK layered（`elk.direction:'RIGHT'`，尊重 `pinned` 作锚点），接受 423KB 懒加载载荷。**绝不放在流式路径上。**
6. **30–120 分钟的防泄漏纪律**。把大段 transcript 文本**排除在 `node.data` 之外**（只存 title + `sourceTranscriptIds[]`，正文放可修剪的独立 slice）；**`nodeTypes`/`edgeTypes` 提升到模块作用域**（每次重建会导致全部节点 remount —— React Flow 最经典的重复渲染/泄漏陷阱）；开 `onlyRenderVisibleElements`；默认折叠 depth>2–3；把一次 LLM 响应内的操作在 ~500ms 窗口内合并成一次 `setNodes`；`useEffect` cleanup 里终止 layout worker / transcript 流 / ResizeObserver。

**亚军：Cytoscape.js + `null`/`preset` 布局 + `fcose` 的 `fixedNodeConstraint`** —— 原始规模上限更高（Canvas，社区 ~5000 节点真实数据），自带展开折叠与多种布局。**落选原因**：位置稳定仍需纪律（惯用法"跑个 layout"会全排）；React 包装器 2022 年冻结只能命令式操作；富 HTML 节点卡片（title+summary+confidence）远难于 React Flow 的真实 DOM 自定义节点；默认观感是"网络图"而非"思维导图"。**第三选择**：AntV G6 v5（Canvas、MIT、`addData` 增量、DOM 节点扩展）—— 若节点数超出 React Flow 的 DOM 承载则是最佳折中，代价是 v5 刚重写、文档中文优先。

**专用导图库（jsMind / mind-elixir / simple-mind-map / markmap）为什么全部出局**：它们把「看起来像导图、不用手拖也合理」免费做好了，但**没有一个满足增量稳定** —— 每个都自己拥有模型并在结构变化时重跑自己的树布局，坐标不稳定，且都不能干净消费我们的 add/move/merge 操作 schema。另有成熟度红旗：mind-elixir 的 `latest` 是预发布版，simple-mind-map 的 `latest` 是 hotfix 版。

### 8.4 本机环境实操坑（影响后续所有 Phase 的依赖安装）

- 此 Windows 机器上 `curl` 访问 `github.com` HTML、`registry.npmjs.org`、`raw.githubusercontent.com` 会因 schannel **`CRYPT_E_REVOCATION_OFFLINE`** 失败，需加 **`--ssl-no-revoke`**。
- `api.github.com` 匿名可达但限流 **60 次/小时**（本次侦察约 34 次调用后即触顶）→ 元数据优先用 npm registry + bundlephobia。
- npm registry 可达但极慢（本机实测 `npm ping` **PONG 27 秒**）；PyPI 频繁读超时。→ Phase 1 脚手架与后续 `npm install` 需预留长时间，并考虑配置国内镜像源。

---


## 9. Embedding / 向量检索 / 长期记忆（Phase 0 侦察 + Phase 7 落地回填）

> 本章补得晚：Phase 0 的检索侦察结论散在 ADR §9，直到 Phase 7 把代码写完、跑出本机数字才回写到这里。数字分两类标注：**[实测]** = 本机当次跑出来的；**[侦察]** = Phase 0 跑过但产物已不在磁盘、当前不可复核的。

### 9.1 下载渠道可达性 [实测 2026-10-18]

| 渠道 | 结果 |
|---|---|
| `huggingface.co` | **不可达**（15s 超时，HTTP 000）——与 §0/§1.1 的 STT 模型结论一致，权重只能走镜像 |
| `hf-mirror.com/BAAI/bge-m3` | 200 / 2.16s |
| `www.modelscope.cn/models/BAAI/bge-m3` | 200 / 0.55s（**更快，且 Phase 0 用它跑通过 Node 侧推理**） |

`@huggingface/transformers` 走 ModelScope 时需要覆盖 `env.remoteHost='https://www.modelscope.cn/models/'` 与 `env.remotePathTemplate='{model}/resolve/{revision}/'`；默认模板拼出来的 URL 对 HF Hub 有效、对 ModelScope 无效 —— 这是 Phase 0 卡过的点，登记以免 #21 重踩。

### 9.2 候选模型与运行时（npm 元数据 [实测 2026-10-18]）

| 项目 | 版本 | License | 结论 |
|---|---|---|---|
| BAAI/bge-m3（ONNX q8：`Xenova/bge-m3`） | 1024 维，多语言 | **MIT（权重）** | **已采用**为默认 `EMBED_MODEL`；本机实测见 §9.3/§9.4，登记见 THIRD_PARTY 第 14 条 |
| `@huggingface/transformers` | 4.3.1 | Apache-2.0 | **已采用**：Node 侧 ONNX 推理入口，**不需要 Python**；全仓库只在 `retrieval/embeddingWorker.ts` 一处引用，登记见 THIRD_PARTY 第 13 条 |
| `onnxruntime-node` | 1.30.0 | MIT | 底层 runtime，transformers 已带；CPU 推理**不需要它的 install script**（ADR §9.2 D-14） |
| sqlite-vec | 0.1.9 | MIT OR Apache | **未采用**（ADR §9.2 D-6：量级还没到需要 ANN） |
| jina-embeddings-v3 | — | **CC-BY-NC-4.0** | **禁用**（非商用授权，见 §4 排除清单与 ADR §10） |
| FAISS / 任意独立向量服务 | — | MIT / 各家 | **排除**：违设计文档 §30"向量与元数据同库"与 Rule 1 |
| Ollama / 本地 embedding 服务 | — | MIT | 排除：引入独立进程与端口，为一个未证明的需求（Rule 6） |

### 9.3 语义质量 [实测 2026-10-18，#21 已重测]
bge-m3（q8、mean pooling、normalize）跨语言等价：`世界模型 ↔ "World Model"` cosine **0.9129**，同批语料里 `Xenova/bge-base-zh-v1.5` 只有 **0.6779**（侦察期记的 0.8728/0.5946 是同一现象、不同样本，量级一致）。这是词法方案的根本能力边界，也是 Phase 7 的 `MockEmbeddingProvider`（CJK 单字+双字 bigram、512 桶签名哈希）**明确做不到**的事。因此 mock 模式下的任何检索指标都只是**下界**，不能用来反证真实模型不好，也不能反过来把 mock 的分数当质量。

- [实测 2026-10-18] **绝对分数整体偏高，必须重新校准阈值**：真实会话索引 6 条、三类提问（`.scratch/calib-scores.mjs`，直接读 `embeddings` 表算 cosine）：

  | 提问 | 命中目标句 | 同主题干扰句 | 完全离题最高 |
  |---|---|---|---|
  | 「这项技术能用在哪些场景，比如机器人和自动驾驶？」 | **0.9565** | 0.7114–0.7711 | — |
  | 「世界模型和语言模型的区别是什么？」 | 0.8694 | 0.7936–0.8236 | — |
  | 「今天中午吃什么？」 | — | — | **0.6617** |

  无关句能到 0.66，所以 mock 用的 0.1 门槛在真实向量空间等于不过滤；**采用 0.75**（留住 0.87–0.96 的答案句，丢掉离题噪声），依据与副作用记在 ADR §9.2 D-13。

### 9.4 推理延迟与索引规模
- [实测 2026-10-18] **摄取**：真实 provider 单条端到端 **46–93 ms**（`metric:embedding_batch`，三次会话共 12 批全为 `count:1`）；模型冷加载 **4.9–5.4 s**（4 次独立进程），因此 boot 即 `prewarm()` 且不 await。对照侦察期的"175 ms/段"：本机比那个估计更快，按中位 55 ms 算 3000 段 ≈ 2.8 分钟而非 8.8 分钟，讲中持续摄取绰绰有余。
- [实测 2026-10-18] **主 loop 侵占**是这一节的决定性数字：同一负载（12 段 ×4 批）放线程内，5 ms 心跳 gap p99 **30.1 ms**；放主 loop 内，每批 369–440 ms、心跳在 4 批期间只响 11 次（应约 848 次）、gap p99 **1881 ms**。字幕与 partial 的排队形状只有线程摆法能消除，而线程摆法在真实全链路里的字幕投递延迟是基线 2 ms、p95 +3 ms、最大 +4 ms。原始输出：`.scratch/worker-loop.txt`、`.scratch/probe-inline-loop.mjs`。
- [实测 2026-10-18] **查询**：`metric:retrieval_search` 在 6 行索引上 50–62 ms（含把提问喂给模型），命中情形 `hits=2 topScore=0.957`，离题情形 `hits=0 topScore=0.662`。
- [实测 2026-10-18] 检索侧（暴力 cosine，`:memory:` 库，25 次取中位，`.scratch/bench-scan.ts`）：

  | 规模 | scan（SQL 读 + BLOB 解码） | rank（纯点积 + 排序） | 合计中位 |
  |---|---|---|---|
  | 1024×1000 | 14.7 ms | 4.4 ms | 19 ms |
  | 1024×3000（≈1 小时） | 54.3 ms | 14.1 ms | 68 ms |
  | 1024×6000（≈2 小时） | 117.2 ms | 29.1 ms | 146 ms |
  | 512×3000（mock 维度） | 33.5 ms | 5.9 ms | 39 ms |

- 与 [侦察] 那句"3000×1024 暴力扫 9.4 ms/query"**对账**：那说的是纯内存点积，对应本表的 `rank` 列（14.1 ms），无矛盾；差一个数量级的是每次查询重新走 SQL 并把每行 BLOB 复制成 `Float32Array`。**结论仍是 ANN 不必要，但要修正"毫秒级"的说法**：真实成本是几十毫秒的一段同步阻塞，期间字幕与 partial 排队。复评阈值（>3000 行或 p50 >100ms）与详细取舍记在 ADR §9.2 D-6。
- [实测] 端到端可用性（Mock 向量，下界）：`MOCK_STT/MOCK_LLM` 全链路跑通一次 Test D 形状的问答 —— 8 段讲、`indexed=8 dropped=0`、一次查询 `candidates=6 hits=1 topScore=0.609 latencyMs=2`，回答引用了已落在热窗口之外的 `[00:20]` 那行。
- [实测 2026-10-18] **同一形状在真实模型上复现**：`MOCK_EMBEDDING=false RETRIEVAL_MIN_SCORE=0.75 HOT_CONTEXT_SEC=20`，讲到 52 s 时提问，`candidates=4 hits=2 topScore=0.957`，citations 含 `{startTime:20}`（此时热窗口下界是 32 s，该行只可能来自索引）；换成离题提问则 `hits=0 topScore=0.662`，回答自动退回只用热上下文、不塞垃圾、不报错（`.scratch/live-onnx-retrieval.mjs`，日志 `.scratch/srv11.txt`）。
- 仍未挪出主 loop 的是**查询里的 `scan`**（几十毫秒的同步段，见上表）—— 推理已经离线，这段是 D-6 复评阈值继续存在的原因，不是遗漏。

### 9.5 长期记忆（设计文档 §31）
不引入任何框架：`SummaryBlock` append-only + 分层 merge 全部是自有代码 + SQLite（ADR §9.1 D-1…D-5）。侦察过的替代是各家"agent memory"库（LangChain Memory、mem0 一类），**全部排除**：它们把"摘要"变成第三方策略黑盒，而 §31 要的恰恰是可证明的"不覆盖历史"与可控的 prompt 组成，且都带一大棵依赖树（Rule 1 的"成熟库优先"在这里被"需求本身只有 append + 归并"抵消）。

### 9.6 仍未回答
1. ~~ONNX 推理放主进程还是 `child_process`~~ —— **已答（#21）**：既不是主进程也不是独立进程，而是同进程内的 `worker_threads`；对照实测见 §9.4 与 ADR §9.2 D-12。
2. 权重已落盘（`models/embedding/Xenova/bge-m3`，q8 实测 560 MB，冷加载 4.9–5.4 s），**仍未回答**的是首次下载与离线打包：目标机若不能访问 `hf-mirror.com`，就要把权重随安装包分发或提供预取脚本，这属于发布工程，Phase 9 之后处理。
3. ~~每段 175 ms 的 [侦察] 数字~~ —— **已重测**：本机 46–93 ms/段（§9.4）。§3 的"AI 请求不堆积"预算因此有余量：讲座语速约 10 s/段，模型约 18 段/秒 的处理能力意味着队列长度理论上恒为 0，实测三会话 `dropped=0`。
4. **新出现、尚未回答**：攒批（`EMBED_BATCH_SIZE=16`）在真实负载下从未被压到（全是 `count:1`），所以这条路径的正确性只有单测保证，吞吐收益未知。要么在 Phase 9 的长录里构造积压，要么承认它是纯保护性参数并删掉攒批的错觉。
