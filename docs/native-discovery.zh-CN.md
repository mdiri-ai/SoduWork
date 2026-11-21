# 原生投屏与会话中继发现

**简体中文** · [English](native-discovery.en.md) · [文档导航](README.zh-CN.md)

桌面端复用已认证的账号同步 WebSocket，不额外建立连接。投屏或中继请求提交后，Hub 会向请求的来源设备**及其所属账号**发布一条 `native-discovery` 提示。提示中不包含指令、对话内容或凭据。桌面端仍需拉取队列，并沿用既有的同意、领取与确认这三条授权路径。

## 轮询与兼容性

- 轮询串行执行，单次超时 12 秒，释放时取消。短时间内集中出现的提示会合并；提示不会绕过认证与错误退避。
- 空闲 HTTP 发现按 20% 抖动退避。在未获得原生 WebSocket 能力确认时，保持在 20 秒的回退区间内。中继回退会在该区间内为请求时长预留预算，以维持原有 30 秒的可用性租约。投屏活跃时保持 3 秒轮询，中继活跃时保持 5 秒轮询。出错后退避至 60 秒。
- 原生服务每 15 秒广播一次自身能力。Socket 获得确认后，空闲 HTTP 发现可延长至 60 秒。5 秒内未收到确认或 Socket 关闭时，立即唤醒 HTTP 回退。仅具备投屏能力时，绝不广播中继可用性。
- 新客户端连接旧 Hub 时收不到能力确认，继续使用有上限的 HTTP 回退。旧客户端连接新 Hub 时继续使用原有的 `Client.config.personalConversationRelay` 租约；写入被限流至每 10 秒一次。PostgreSQL 的续租会在行锁下跨 worker 重新读取，并保留与之无关的配置。原有租约的过期时间仍为 30 秒。
- 升级客户端前，先把 Hub 的数据库迁移与代码部署到所有副本。新旧 Hub 版本混布的滚动池无法与旧代码共享新的临时在线状态协议；本兼容性保证只适用于 Hub 池版本一致、客户端同为新版或旧版的情况。

## 可用性与身份

新的中继在线状态是临时的，TTL 为 30 秒，以设备、所属者和设备认证版本为键。单进程部署时保存在有界的进程内映射中，配置了集群时保存在共享 Redis 中。Redis 故障会报告为不可用，绝不用本地在线状态静默顶替。新客户端的心跳不会改写 `Client.config`。

客户端在异步发现与同意之后、执行原生操作之前，会再次校验 Hub、设备、账号与认证世代。其持久化的中继提交栅栏保持不变：确认丢失后不能重新提交同一原生轮次。原生能力消息只在已认证的 Socket 上传输；渲染进程事件无法唤醒或广播该能力。

## 查询边界

- 空投屏发现与新中继发现各自只执行一次队列 SELECT，不产生业务数据的 UPDATE 或 COMMIT。认证是独立环节，仍沿用既有的 last-seen 限流。
- 投屏发现在 SQL 中排除已过期行，最多返回 20 条授权。仅在结果非空时才查询查看者名称。每次新请求最多清理 100 条过期授权；授权环节独立校验过期。迁移 `0079_native_discovery` 为两条路径新增来源、状态与过期组成的索引。
- 中继发现最多返回 20 个任务，并一次性批量加载其当前的来源会话与设备。已过期且已完成准备的任务通过一次有界更新批量退役，避免逐个任务提交。

## 针对性验证

```powershell
node --test client/tests/native-discovery.test.cjs client/main/remote-screen-source.test.cjs client/main/conversation/account-sync.test.cjs client/tests/personal-conversation-relay.test.cjs client/tests/personal-conversation-relay-runtime.test.cjs client/tests/personal-relay-ipc.test.cjs
cd hub-backend
.\.venv\Scripts\python.exe -m unittest test_native_discovery tests.test_personal_conversation_relay test_remote_screen_protocol test_realtime_account_scope
```

测试使用伪造时钟、隔离的 SQLite、伪造的共享 Redis、限定作用域的 WebSocket，以及带本地模型 fixture 的真实 Pi 会话。覆盖范围包括 20 分钟请求预算、漏推与心跳回退、取消、过期身份栅栏、单次发送回执、队列查询次数，以及迁移的升级与回退。这些测试不构成生产环境 PostgreSQL 与 Redis 的容量基准。
