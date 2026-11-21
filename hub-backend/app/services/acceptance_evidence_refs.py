"""Optional per-check references to the current gate's fingerprinted evidence."""
from __future__ import annotations

import re

from fastapi import HTTPException

from .. import automation_models as am
from . import gate_contract

MAX_REFS_PER_CHECK = 20
MAX_REPORT_REFS = 200
_SHA256 = re.compile(r"[0-9a-f]{64}")
_COMMIT = re.compile(r"[0-9a-f]{40}(?:[0-9a-f]{24})?")


def _invalid(check_index: int, ref_index: int | None, reason: str) -> None:
    path = ["report", "checks", check_index, "evidenceRefs"]
    if ref_index is not None:
        path.append(ref_index)
    # A field location is actionable without revealing another task's evidence
    # or echoing a supplied URL, path, digest or private note.
    raise HTTPException(422, {
        "error_code": "invalid_acceptance_evidence_ref",
        "message": "验收报告检查项格式不正确",
        "parameters": {"path": path, "reason": reason},
    })


def normalize(value: object, check_index: int) -> list[dict]:
    if not isinstance(value, list) or len(value) > MAX_REFS_PER_CHECK:
        _invalid(check_index, None, "invalid_list")
    normalized, seen = [], set()
    for index, item in enumerate(value):
        if not isinstance(item, dict) or set(item) - {"kind", "ref", "fingerprint", "note"}:
            _invalid(check_index, index, "invalid_shape")
        kind, ref, fingerprint = item.get("kind"), item.get("ref"), item.get("fingerprint")
        if not isinstance(kind, str) or kind not in gate_contract.EVIDENCE_KINDS:
            _invalid(check_index, index, "invalid_kind")
        if not isinstance(ref, str) or not ref.strip() or len(ref) > 512:
            _invalid(check_index, index, "invalid_ref")
        digest = _COMMIT if kind == "commit" else _SHA256
        if not isinstance(fingerprint, str) or not digest.fullmatch(fingerprint):
            _invalid(check_index, index, "invalid_fingerprint")
        if "note" in item and (not isinstance(item["note"], str) or len(item["note"]) > 1000):
            _invalid(check_index, index, "invalid_note")
        ref = ref.strip()
        if (kind, ref) in seen:
            _invalid(check_index, index, "duplicate_ref")
        seen.add((kind, ref))
        normalized.append({"kind": kind, "ref": ref, "fingerprint": fingerprint,
                           **({"note": item["note"].strip()} if "note" in item else {})})
    return normalized


def options(artifact: am.ArtifactVersion, evidence: list[dict]) -> list[dict]:
    """Offer only fixed-version IDs and matching frozen attachment digests.

    Legacy evidence without a reliable digest remains in the ordinary gate and
    text reports. It is never assigned an invented immutable fingerprint.
    """
    frozen: dict[str, set[tuple[str, int]]] = {}
    manifest = dict(artifact.manifest or {})
    for key in ("files", "primary", "supporting", "evidence"):
        for item in manifest.get(key) or []:
            if not isinstance(item, dict):
                continue
            aid = str(item.get("id") or item.get("attachmentId") or "")
            digest, size = item.get("sha256"), item.get("size")
            if (aid and isinstance(digest, str) and _SHA256.fullmatch(digest)
                    and isinstance(size, int) and not isinstance(size, bool) and size >= 0):
                frozen.setdefault(aid, set()).add((digest, size))
    out = []
    for item in evidence:
        kind, ref = item.get("kind"), item.get("id")
        if kind not in gate_contract.EVIDENCE_KINDS or not isinstance(ref, str) or not ref:
            continue
        aid = str(item.get("attachmentId") or "")
        if aid:
            versions = frozen.get(aid, set())
            meta = item.get("meta")
            digest = meta.get("sha256") if isinstance(meta, dict) else None
            size = item.get("size")
            if not isinstance(digest, str) or not _SHA256.fullmatch(digest) or not isinstance(size, int):
                continue
            current = (digest, size)
            if len(versions) != 1 or current not in versions:
                continue
            fingerprint = current[0]
        else:
            source = dict(item.get("source") or {})
            if (source.get("artifactVersionId") != artifact.id
                    or not ref.startswith("artifact:" + artifact.id + ":")):
                continue
            fingerprint = artifact.commit_sha if kind == "commit" else artifact.checksum
            digest = _COMMIT if kind == "commit" else _SHA256
            if not isinstance(fingerprint, str) or not digest.fullmatch(fingerprint):
                continue
        out.append({"kind": kind, "ref": ref, "fingerprint": fingerprint})
    return out[:MAX_REPORT_REFS]


def verify(report: dict, choices: list[dict]) -> None:
    by_id = {(item["kind"], item["ref"]): item["fingerprint"] for item in choices}
    count = 0
    for check_index, check in enumerate(report["checks"]):
        for ref_index, item in enumerate(check.get("evidenceRefs", [])):
            count += 1
            if count > MAX_REPORT_REFS:
                _invalid(check_index, ref_index, "too_many_refs")
            if by_id.get((item["kind"], item["ref"])) != item["fingerprint"]:
                _invalid(check_index, ref_index, "unbound_or_changed")
