# 在 GitHub 网页端提交文件失败的排查记录（CodeMirror 与提交路径）

记录一次用浏览器自动化在 GitHub 网页端提交文件时遇到的实际问题，以及可用的替代路径。面向需要对 GitHub 做批量或脚本化提交的场景。

## 现象

通过脚本操作 GitHub 的“新建文件”页面（`/<owner>/<repo>/new/<branch>`），填入文件内容后点击提交，页面在对话框里报错：

```
There was an error committing your changes: File could not be edited
```

页面没有跳转，文件也没有创建——用 `https://raw.githubusercontent.com/<owner>/<repo>/main/<path>` 去取，返回 404。

## 直接原因

新建文件页的编辑器是 CodeMirror。它的可见内容由内部状态驱动，直接修改 DOM（例如 `element.innerText = content`，或对编辑区派发 `ClipboardEvent('paste')`）只会改变**显示**，不会更新 React/CodeMirror 持有的文档状态。

提交时页面拿到的仍是空文档，于是服务端判定为“无有效变更”并拒绝写入，错误信息就成了 `File could not be edited`。

从界面看，内容明明已经显示在编辑器里；从网络请求看，提交的 payload 里内容为空。这两个视图不一致，是这个问题的迷惑点。

## 判断方法

提交前不要相信编辑器的**显示**，而要读它**对外声明的值**：

```js
// 若页面挂了 hidden 的 blob 输入，可直接核对长度
const hidden = document.querySelector('input[name="value"]');
console.log(hidden && hidden.value.length);
```

更通用的做法是检查编辑器的数据源（如 CodeMirror 实例的 `getValue()`）。如果 DOM 长度大于 0 而数据源长度为 0，就说明只改了 DOM，提交必然失败。

## 可用路径

### 路径一：改用上传通道

GitHub 提供上传页面，绕开 CodeMirror：

```
https://github.com/<owner>/<repo>/upload/<branch>/<dir>
```

该页面使用原生 `<input type="file">`，通过 DevTools 的 `DOM.setFileInputFiles` 或模拟选择文件即可放入文件，文件内容由浏览器直接读取，不经过编辑器状态，因此不会出现上面的问题。

创建子目录中的文件时，**目录要写在 URL 里**（`/upload/main/docs`），不要试图在文件名输入框里写 `docs/xxx.md`——文件名输入框会截掉路径部分，只保留文件名。

### 路径二：走 REST API

```
PUT https://api.github.com/repos/<owner>/<repo>/contents/<path>
```

以 Base64 提交文件内容，可直接创建或更新。需要带 `Authorization: Bearer <token>`（fine-grained PAT，需 `contents: write` 权限）。适合批量提交。

注意：提交到非默认分支时需同时给出 `branch` 字段，否则会直接写入默认分支。

### 路径三：本地 clone 后推送

自动化里最稳的一条。`git clone` → 写文件 → `git commit` → `git push`，完全避开网页编辑器的状态问题。代价是需要配置凭据。

## 顺带记录的一个网络观察

排查期间遇到 `github.com` 网页端间歇性超时（`net::ERR_CONNECTION_TIMED_OUT`，`curl` 同样返回 000），而 `api.github.com` 同时段稳定可用（约 2.5s 返回 200）。

所以写 GitHub 自动化脚本时，把**网页操作**和 **API 操作**分开重试、分开降级，比整体重试更有效：网页端不可达时，API 路径往往仍然能完成同样的提交。

## 小结

- 网页编辑器“看起来有内容”不等于“提交时有内容”，以数据源为准；
- 需要写入文件时优先用上传通道或 API，不要在 CodeMirror 里写 DOM；
- 子目录建文件靠 URL，不靠文件名里的斜杠；
- 网页端与 API 域名的可用性会分别抖动，分开降级。

---

排查环境：Windows，Chromium（DevTools Protocol 驱动），GitHub 网页端。问题可复现，上述上传通道已验证可用。
