# 版本号与 Windows 安装向导

向导首次交付版本：`0.1.0-desktop-preview.5`，以下安装器专项证据按该版保留。当前应用版本及安装包见仓库 README 与 CHANGELOG。向导保留当前应用业务、独立 Node 后端和用户数据布局。

## 使用安装向导

双击安装包，依次经过欢迎、安装位置、快捷方式、确认、安装进度与完成。可以直接输入中文/含空格路径，也可浏览本机文件夹；桌面和开始菜单快捷方式分别选择。安装完成后可勾选启动应用。

“上一步”保留选择；安装开始前取消不会写入目标目录。写入程序文件期间暂停关闭/取消操作，完成后即可退出。目标文件被占用时先显示失败原因与日志，正常退出对应应用后可以重试；安装器不终止任何应用或后台。

沿用 Windows 已有 .NET Framework 编译器与 WinForms，不额外安装打包工具。GUI 安装包不打开多余控制台，普通用户可安装到可写目录。路径选择器按需读取本机文件夹，避免旧版 shell 文件夹选择框曾出现的阻塞。

此版保留既有配置、数据库和模型，不迁移旧安装版数据。没有新增自动更新、签名或卸载向导；这些仍是后续交付工作，不将安装向导等同完整发布系统。

## 版本来源与命令

`packages/desktop/package.json` 是桌面版本来源；锁文件、暂存目录、运行时清单、安装器元数据和安装包名需一致。应用标题与“帮助 → 关于实时会议助手”显示该版本。

```powershell
node tools/desktop-version.mjs
node tools/desktop-version.mjs --set=0.1.0-desktop-preview.6
npm run dev:desktop
npm run build
npm run package:desktop
```

第二条是下一版的示例命令，执行后需要更新 `CHANGELOG.md` 并重新构建。当前版通用打包产物：

`outputs/desktop-preview/v0.1.0-desktop-preview.5/RCC-Desktop-Preview-0.1.0-desktop-preview.5-Setup.exe`

不覆盖历史版本。同版产物存在时打包拒绝；只有修正尚未交付的本地构建时，才显式给 `tools/make-installer.mjs` 加 `--replace`。已交付后应提升版本。`installed-version.txt` 记录本次成功安装版本，Windows 文件属性包含完整产品版本与对应四段文件版本。

无交互安装仍可用：

```powershell
& "<安装包绝对路径>" --quiet --target="D:\Apps\实时会议助手-桌面预览"
```

`--no-shortcut` 同时跳过桌面和开始菜单快捷方式；不带 `--quiet` 时，`--target` 只预填向导目录。取消返回 2、失败返回 1、成功返回 0。安装日志默认位于 `%LOCALAPPDATA%\RCC-Installer\logs\`；测试可显式设置 `RCC_INSTALLER_LOG_DIR`。

## 可重复验证

```powershell
npm run test:installer-wizard
node tools/verify-desktop.mjs --installer="<安装包>" --install-mode=wizard --work="<全新独立测试目录>"
```

第一条使用独立的安装器测试载荷，运行真实编译 EXE 的原生控件、压缩解包和快捷方式逻辑，检查版本、取消、路径浏览、前后导航、选项、进度、完成启动、重装保留、文件占用失败和重试，也启动实际安装器入口检查有窗口且取消正常。启动后的测试程序只写自己的标记，不把它当成会议应用验收。

第二条对正式应用安装包实际走完整原生向导，随后在无系统 Node 路径的环境下运行真正的桌面业务回归；重装也经过向导，并核对非空测试数据库/配置/模型标记保留。标题与“关于”版本同时检查。测试使用 `Application.Run` 的完整消息循环，匹配正式向导的后台完成通知。

本轮证据与安装包在当前版本输出目录；以 `wizard-verification.json`、`verification.json`、`side-install-verification.json`、`package-audit.json` 和校验文件为准。安装失败不会显示“安装完成”；逐文件临时写入并替换不等于跨整次安装的事务回滚，强制终止仍需重装恢复程序文件，用户数据保留。

## 第 5 版实际验证结果

- 46 个测试文件、346 项自动测试通过；类型检查、构建、lint 通过。lint 保留原有 `review-probes.ts` 的 12 个 warning 和 1 个 info，本轮文件没有新增诊断。
- 18 项安装器专项检查通过；41 项正式安装版桌面流程通过，包括真实原生向导安装/重装、中文和空格路径、窗口与关于版本、独立 Node、模拟业务、会议恢复、端口占用和正常/异常退出。
- `D:\Apps\实时会议助手-桌面预览` 已通过同一向导更新，桌面与开始菜单快捷方式均指向该安装；配置字节和数据库保留。实际旁路库更新前为空，非空保留由独立目录中的两场测试会议重装验证，不将此项写成旧版个人会议迁移成功。
- 旧版后台运行期间未被终止。默认文件读取曾因旧数据库占用受阻，随后用共享只读方式核对，旧配置、数据库、旧快捷方式与原型文件校验值一致。
- 包含 4,704 个核心文件，模板密钥为空；没有实际 `.env`、会议数据库、音频、语音权重、Python 环境或真实 embedding 运行时。安装包校验值保存在同名 `.sha256` 文件。
- 安装器早期控制台测试探针未使用完整消息循环，导致完成通知与控件切换失败；已修正测试运行器，使其与正式程序一样使用 `Application.Run`。失败日志保留在 `work/wizard-ui-tests.log`、`work/wizard-ui-diagnostic.log`，最终记录为 `work/wizard-ui-release.log`。没有删除或放宽原断言。

本轮没有执行真人麦克风或识别准确率验收；CPU 固定语音识别仍引用第 4 版独立证据。不会把安装成功、模拟业务或语音通道 ready 写成真实硬件和模型效果通过。
