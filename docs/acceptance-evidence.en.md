# Structured AI acceptance evidence

[简体中文](acceptance-evidence.zh-CN.md) · **English** · [Documentation](README.md)

AI acceptance already binds the complete report to an approval, a requirement
version and a fixed artifact version. A check can additionally cite the exact
recorded evidence it reviewed, while keeping its human-readable `evidence` text.
References identify evidence; they do not prove that a criterion passed.

`GET /api/v1/tasks/{taskId}/acceptance-context` supplies optional
`evidenceRefOptions`, using IDs and kinds from the task's existing gate packet:

```json
{
  "kind": "text",
  "ref": "artifact:example-version:text",
  "fingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

After actually checking the deliverable, a reviewer may copy an option into the
corresponding report check sent to `POST /api/v1/tasks/{taskId}/auto-review`:

```json
{
  "criterion": "criterion-1",
  "result": "pass",
  "evidence": "Read the fixed essay and counted 410 words.",
  "evidenceRefs": [
    {
      "kind": "text",
      "ref": "artifact:example-version:text",
      "fingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "note": "The fixed essay checked for this criterion."
    }
  ]
}
```

Use the returned `kind`, `ref` and `fingerprint` exactly. Artifact references use
the recorded artifact checksum, or the fixed Git commit for a code artifact.
Attachment references require the current attachment's SHA-256 and size to match
its entry in the fixed manifest. The same gate kinds apply: `file`, `url`,
`commit`, `text`, `check`, and `image`; a kind alone does not make an ID valid.
Only evidence exposed by the current task's gate and backed by these fixed
records is offered. Arbitrary URLs, paths, attachment aliases and log ranges are
not resolved. A URL artifact fingerprint identifies the recorded version; it
does not freeze or verify the current bytes served by an external website.

The server validates new references before recording a decision and retains
them in the saved per-check report and acceptance event. Missing, changed,
cross-task, mismatched and malformed references receive HTTP 422 with
`error_code: invalid_acceptance_evidence_ref` and the per-reference location in
`parameters.path`. Error details do not disclose another task's evidence.
Each check allows 20 references and an optional note of at most 1,000 characters;
each report and choice list are bounded to 200 references.

Existing text-only reports, stored approval reports and attachments without
reliable historical digests retain their existing behavior. Such evidence
remains available in the normal gate, without an invented fingerprint. An empty
`evidenceRefs` array is valid. Exact criterion coverage, textual evidence,
verdict consistency, actor permissions, current version checks and manual-only
delivery rules still apply. No data migration or resource recreation is needed.

Deploy the Hub change first. Existing clients continue to submit text reports;
updated desktop and cloud reviewers offer optional references from the Hub.
An updated desktop working with an older Hub keeps the text-only workflow, and
a queued reference-aware review rejects changed or removed reference choices.
Previously committed decisions retain their existing idempotent retry behavior.

Contract checks use isolated data and the real approval service. Run
`python3 -m unittest tests.test_task_acceptance_review tests.test_cloud_acceptance`
in `hub-backend/` and `node --test tests/acceptance-turn.test.cjs` in `client/`.
These checks establish reference binding and compatibility; they do not establish
real-model review accuracy or native desktop acceptance.
