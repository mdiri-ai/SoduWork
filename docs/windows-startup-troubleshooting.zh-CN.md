# Windows 源码启动排障（国内网络环境）

本文记录在一次真实的 Windows 源码启动中遇到的四类失败及处理方式，适用于从 GitHub 克隆仓库后使用 `sh start.sh --desktop` 启动的场景。所有命令均在 Git Bash（MINGW64）中验证。

## 1. `git clone` 报 `0x80092012`

现象：

```text
fatal: unable to access 'https://github.com/<user>/SoduWork/':
schannel: next InitializeSecurityContext failed: Unknown error (0x80092012) - 吊销功能无法检查证书是否吊销
```

原因：Git for Windows 使用 `schannel` 后端时，会检查服务端证书的吊销状态；在部分网络环境下无法访问 CRL/OCSP 端点。

处理：

```bash
git config --global http.sslBackend schannel
git config --global http.schannelCheckRevoke false
```

这只跳过「证书是否被吊销」的检查，仍会校验证书链。若改用 `http.sslBackend openssl`，需要先正确配置 `http.sslCAInfo`，否则会报 `unable to get local issuer certificate`。不建议设置 `http.sslVerify false`。

## 2. 首次启动无法设置管理员密码

现象：

```text
SoduWork could not start: Run from an interactive terminal to choose the administrator password.
Automation may explicitly pass --password-stdin.
```

原因：当前终端的 `sys.stdin.isatty()` 为 false，启动器无法调用 `getpass` 做隐藏输入；这是安全设计，不是故障。

处理：显式从标准输入提供首次密码，密码不要写进命令行参数或脚本文件：

```bash
read -s -p "设置管理员密码(12-128位): " PW; echo
printf '%s\n' "$PW" | sh start.sh --desktop --password-stdin
unset PW
```

若 `read -s` 在当前终端不可用，可用 Python 的 `getpass` 从控制终端读取后通过管道传入：

```bash
python -c "import getpass; print(getpass.getpass('Password: '))" | sh start.sh --desktop --password-stdin
```

注意：系统里的 `python` 可能低于 3.12（启动器要求 3.12+），CMD 下 `py -3.12` 也可能没有可用运行时。以 Git Bash 中 `start.sh` 实际找到的解释器为准，不要在 CMD 中直接运行 `start.cmd`。

## 3. Electron 运行时下载失败

现象：

```text
[Desktop] 下载桌面运行环境失败 (exit 1)
TypeError: fetch failed
  at FetchDownloader.download (...)
```

原因：`@electron/get` 默认从 GitHub Releases 下载，国内网络可能不可达。

处理：使用国内镜像后重跑同一个启动命令，已完成的步骤会复用：

```bash
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
```

## 4. PortableGit 运行时下载失败

现象：

```text
[SoduWork shell runtime] ... UNABLE_TO_VERIFY_LEAF_SIGNATURE
Error: PortableGit download failed
```

原因：Node 侧 TLS 证书链校验失败。`SODUWORK_PORTABLE_GIT_MIRROR` 需要指向可直接拼接 `<tag>/<file>` 的 HTTPS 目录；部分公共镜像尚未收录较新的 PortableGit 版本。

处理：如果下载目标由启动器校验固定 SHA-256，可以在这一次启动中临时关闭 Node 的证书校验——文件被篡改仍会被哈希校验拦下：

```bash
export NODE_TLS_REJECT_UNAUTHORIZED=0
```

也可以预先下载官方归档并通过 `SODUWORK_PORTABLE_GIT_ARCHIVE` 指定本地路径；启动器会先校验 SHA-256，不匹配会拒绝使用。

## 最小可用启动命令

把上面几项合起来，在 Git Bash 中执行：

```bash
cd /path/to/SoduWork
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export NODE_TLS_REJECT_UNAUTHORIZED=0
read -s -p "设置管理员密码(12-128位): " PW; echo
printf '%s\n' "$PW" | sh start.sh --desktop --password-stdin
unset PW
```

看到下面这行表示启动成功：

```text
SoduWork is ready: http://127.0.0.1:18989
```

之后在浏览器管理端的 **能力配置 → 模型目录** 中添加服务与对话模型，再回桌面端选择该模型和执行底座。模型服务需要有效的额度；余额不足时服务商会返回 HTTP 402，这与 SoduWork 的配置无关。

## 其它提示

- 不要删除数据目录 `%LOCALAPPDATA%\SoduWork\source-service`；失败重跑会复用已下载和已构建的内容。
- Git Bash 中启动日志的中文可能显示为乱码，详细日志可用 UTF-8 终端查看 `startup.log`。
- 退出时按 `Ctrl+C`；桌面窗口的关闭按钮可能只是收进托盘。
