# 将 Antigravity CLI 接入为本机 ACP Agent

**简体中文** · [English](antigravity-acp.en.md) · [文档导航](README.zh-CN.md)

可以通过 **Agent 管理 → 接入新底座**，自行接入 Google Antigravity CLI（`agy`）。本说明使用已安装桌面客户端现有的自定义 ACP 能力，不新增内置底座，也不打包 Google 软件。

请使用本人的 Google 账号和额度，不要多人共用账号或通过此配置转售服务；团队应向厂商配置各自获授权的账号。该账号产生的调用不由 SoduWork 模型额度承担。Antigravity 的数据采集政策（含 Interactions 数据）与免费层条款请以厂商当前说明为准，使用前请查阅。

## 范围与前提

- 已安装的 SoduWork 桌面客户端具有自定义 Agent 入口，能够连接 Hub。
- 单独安装下述 Antigravity CLI（`agy`），**1.5.0 或更高版本**。`agy acp` 子命令自 1.5.0 起提供，更早版本没有 stdio ACP 服务端；1.5.1 起所有账号可用模型都会暴露给 ACP 客户端。版本是显式约束，便于主动评估升级。
- 本配方用于**本机对话**。自定义 Agent 未声明支持 SoduWork 统一访问策略或原生目标模式。其工具可以修改文件和执行命令；这不是只读或沙箱配置。首次对话请使用可丢弃的工作目录。
- 启动 SoduWork 前，先在厂商自己的终端界面登录。SoduWork 自定义 ACP 桥接尚未实现 ACP `authenticate` 交互，也没有 Antigravity 专用的登录或登录状态按钮。

厂商的 [IDE 扩展文档](https://antigravity.google/docs/ide/extensions)规定通过 `agy acp` 启动 stdio ACP（`agentic editors` 一节，server command 即 `agy acp`）。[安装脚本](https://antigravity.google/cli/install.sh)是官方入口；macOS/Linux 二进制默认落在 `~/.local/bin/agy`。

## 1. 安装到独立目录

请选择源码和业务工作区以外的目录。示例使用独立的 SoduWork 用户数据目录，不替换日常客户端设置；需要在这个独立客户端中重新登录 Hub。

Windows PowerShell：

```powershell
$agyRoot = Join-Path $env:LOCALAPPDATA 'SoduWork-Antigravity'
$agyBin = Join-Path $agyRoot 'bin'
$env:SODUWORK_USER_DATA = Join-Path $agyRoot 'desktop'
New-Item -ItemType Directory -Force -Path $agyBin | Out-Null
irm https://antigravity.google/cli/install.ps1 | iex
# 官方安装脚本默认写入 %LOCALAPPDATA%\agy\bin；如需完全独立，
# 将下载的 agy.exe 移动或复制到 $agyBin 后继续。
& (Join-Path $agyBin 'agy.exe') --version
```

macOS / Linux shell：

```sh
agy_root="$HOME/.local/share/soduwork-antigravity"
agy_bin="$agy_root/bin"
export SODUWORK_USER_DATA="$agy_root/desktop"
mkdir -p "$agy_bin"
curl -fsSL https://antigravity.google/cli/install.sh | bash
# 默认安装在 ~/.local/bin/agy；如需完全独立，复制到 $agy_bin。
agy_command="$agy_bin/agy"
[ -x "$agy_command" ] || agy_command="$HOME/.local/bin/agy"
"$agy_command" --version
```

`--version` 输出低于 `1.5.0` 时，先停止后续步骤：该版本线之前不存在 `agy acp`。厂商的安装脚本带自动更新器，升级 Antigravity 后请重新核对版本号与本配方。安装与升级需要访问厂商下载源；网络受限时先解决连通性再继续。以上命令不替换全局 Antigravity 安装。

## 2. 登录后，在同一终端启动桌面客户端

在 PowerShell 执行 `& (Join-Path $agyBin 'agy.exe')`，或在 shell 执行 `"$agy_command"`。按厂商的终端登录说明完成 Google OAuth（浏览器打开授权页、回贴验证码；SSH 或无浏览器环境按提示在别处完成授权 URL），再退出 CLI。ACP 执行使用与 CLI 相同的系统钥匙串凭据；如果 `agy acp` 启动后要求登录而桌面环境无法满足，请在同一用户会话下先交互登录一次。

继续前，先完全退出使用该用户数据目录的 SoduWork 进程。只关闭窗口可能仍在后台运行；再次启动只会唤醒旧进程，不会更新它的环境变量。

在**同一个终端**直接运行已安装的可执行文件。将示例路径替换为实际安装路径。Windows 使用安装根目录稳定的 `SoduWork.exe`，不要使用 `.soduwork-versions` 下某个版本的可执行文件：

```powershell
& 'C:\path\to\SoduWork.exe'
```

```sh
# macOS: use the executable inside the installed application bundle.
"/Applications/SoduWork.app/Contents/MacOS/SoduWork"
# Linux: instead run your installed executable or AppImage by its absolute path.
```

以后每次启动都要设置相同的 `SODUWORK_USER_DATA`，再直接启动可执行文件；无需每次安装，厂商登录状态未过期时也无需重复登录。普通桌面快捷方式不会继承当前终端的环境变量。

**源码启动器限制：**`start.cmd --desktop` / `sh start.sh --desktop` 当前不能为本配方保留桌面环境变量的传递路径；若源码启动器过滤或改写相关变量，请以安装版桌面验证。

安装版桌面会把环境传给自己的私有 Runner。自定义条目没有 home 覆盖，因此 Antigravity 使用其默认的钥匙串与 `~/.gemini` 状态目录。同一目录中的并发对话并不独立；每个账号在同一时间只跑一个 Antigravity 轮次，验证当前版本的并发行为前避免同时运行多个对话。

## 3. 注册本机 Agent

打开 **设置 → Agent 管理 → 接入新底座**，填写：

| 字段 | 内容 |
| --- | --- |
| 底座名称 | `Antigravity CLI` |
| 启动程序 | `$agy_command` 的完整路径，不含两端引号 |
| 启动参数 | 单独一行 `acp` |
| 模型来源 | 使用底座自己的账号与模型 |

点击**保存并接入**。此账号模式不要选择"使用 SoduWork 中的模型"，也不要填写模型环境变量映射。注册使用现有的自定义 Agent 目录机制，无需手改 JSON 文件，也不能手工添加 `install.warn` 或 `runner.home` 字段。

点击**检测程序**可以确认可执行文件是否找到，但不能验证厂商登录、额度、ACP 认证或模型输出。新建本机对话并选择 Antigravity CLI，再分别检查这些能力；发送提示词会使用厂商账号，可能消耗额度。正式使用前，在可丢弃的工作目录中验证简短回答、续聊、取消和文件操作。如果在终端登录后，CLI 仍要求 ACP 认证交互，请停止使用：当前桥接不支持该流程。

## 排查与停用

- **找不到程序：**使用第 1 步的准确路径。Windows 填写 `agy.exe`，不要在程序栏输入 `cmd /c ...` 等 shell 命令。
- **`agy acp` 无输出或立刻退出：**先跑 `agy --version` 确认不低于 `1.5.0`；更早版本没有 ACP 服务端，桥接握手不会成功。
- **终端已登录，ACP 仍要求登录：**确认桌面已完全退出并从相同用户会话重新启动；Antigravity 凭据存于系统钥匙串，跨用户或无头环境不可用。不要将凭据内容上传到问题报告。
- **模型列表不全：**厂商在 1.5.1 起向所有 ACP 客户端开放账号全部可用模型；更旧版本只对固定编辑器列表开放。先升级再核对。
- **版本不对：**对界面实际登记的程序运行 `--version`，在厂商版本说明中评估并验证新的固定版本后再使用。
- **停用本配方：**退出这个独立桌面，从新的终端或日常快捷方式启动原来的 SoduWork，不携带以上临时环境变量。独立目录中的会话会保留；不要通过删除用户数据目录来常规移除 Agent，自定义登记目前采用追加方式。

找到可执行文件或完成未登录的 ACP 握手，不等于已登录对话验收通过。厂商安装、登录与 ACP 行为会随其发行线变化；在自己的环境验证厂商认证、付费调用和原生桌面行为之后，再把这项可选接入用于实际工作。
