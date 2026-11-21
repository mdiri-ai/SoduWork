# AI 验收的结构化证据

**简体中文** · [English](acceptance-evidence.en.md) · [文档](README.md)

AI 验收已将整份报告绑定到审批、需求版本和固定交付版本。每个检查项还可以引用它
实际核查的证据记录，同时保留便于阅读的 `evidence` 文本。引用用于定位证据，不能
证明某项标准已经通过。

`GET /api/v1/tasks/{taskId}/acceptance-context` 提供可选的 `evidenceRefOptions`，
复用当前需求 gate packet 中的证据 ID 和类型：

```json
{
  "kind": "text",
  "ref": "artifact:example-version:text",
  "fingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

实际读取并核查交付物后，验收人可以将一个选项复制到报告的相应检查项，再通过
`POST /api/v1/tasks/{taskId}/auto-review` 提交：

```json
{
  "criterion": "criterion-1",
  "result": "pass",
  "evidence": "已读取固定版本作文并统计得到 410 个词。",
  "evidenceRefs": [
    {
      "kind": "text",
      "ref": "artifact:example-version:text",
      "fingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "note": "本项标准核查的固定版本作文。"
    }
  ]
}
```

按原样使用选项中的 `kind`、`ref` 和 `fingerprint`。交付版本引用使用已有版本的
校验和；代码交付使用固定 Git 提交。附件引用要求当前附件的 SHA-256 和大小与
固定 manifest 中的记录一致。沿用 gate 的证据类型：`file`、`url`、`commit`、
`text`、`check` 和 `image`；仅有合法类型并不能让一个 ID 成为有效引用。
只提供当前需求 gate 已公开、且有上述固定记录支持的证据。不解析任意 URL、
文件路径、附件别名或日志行范围。URL 交付的指纹定位已有版本记录，并不会冻结
或核验外部网站当前返回的字节。

服务端在写入新决策前校验引用，并将其保留在逐项报告及验收事件中。缺失、变化、
跨需求、类型不匹配或格式错误的引用返回 HTTP 422，包含
`error_code: invalid_acceptance_evidence_ref`，以及 `parameters.path` 中的
具体引用位置。错误详情不会透露其他需求的证据。每项最多引用 20 条证据，可选
`note` 最多 1,000 个字符；每份报告及候选列表最多 200 条引用。

旧文本报告、已保存的审批报告和缺少可靠历史摘要的附件保留原有行为。这些证据
仍可通过普通 gate 查看，不会被分配虚构的指纹。空 `evidenceRefs` 数组有效。
完整覆盖标准、文本依据、总论一致性、验收权限、当前版本及仅支持人工确认的
交付规则继续生效。无需数据迁移或重建现有资源。

先部署 Hub 改动。已有客户端继续提交文本报告；更新后的桌面和云端验收根据 Hub
候选项提供可选引用。新桌面连接旧 Hub 时仍走文本报告流程；排队的引用验收会
拒绝已经变化或消失的候选项。已提交决策继续保留原有的幂等重试行为。

契约检查使用隔离数据和实际审批服务。在 `hub-backend/` 运行
`python3 -m unittest tests.test_task_acceptance_review tests.test_cloud_acceptance`，
在 `client/` 运行 `node --test tests/acceptance-turn.test.cjs`。
这些检查验证引用绑定及兼容性，不代表真实模型核查准确性或原生桌面验收。
