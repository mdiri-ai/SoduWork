"""Reject private infrastructure references without disclosing their values."""
from __future__ import annotations

import hashlib
import ipaddress
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[2]
# Fingerprints allow rejection without publishing the private domain itself.
PRIVATE_DOMAIN_HASHES = {"e88426dcde2d1b70d2ac709c04b674873c0eaf47d4d344fc143c6a23a488372b"}
# Only this one-line JSON string is approved for the Armonel build-time default.
ARMONEL_REGISTRY_FILE = "client/scripts/armonel-npm-registry.json"
ARMONEL_REGISTRY_SHA256 = "2006763864e915a8f9bcb3c7b5a70a9645835d2f64656dbdee49008d6d02b1e2"


def findings(name, data):
    if name == ARMONEL_REGISTRY_FILE:
        value = data.replace("\r\n", "\n").removesuffix("\n")
        if hashlib.sha256(value.encode("utf-8")).hexdigest() != ARMONEL_REGISTRY_SHA256:
            return ["unapproved Armonel registry configuration"]
        return []
    errors = []
    for host in re.findall(r"(?<![\w.-])(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?![\w.-])", data):
        labels = host.lower().split(".")
        if any(hashlib.sha256(".".join(labels[i:]).encode()).hexdigest() in PRIVATE_DOMAIN_HASHES
               for i in range(len(labels) - 1)):
            errors.append("private domain")
    if name.startswith((".github/workflows/", "tools/github/")) and not Path(name).name.startswith("test_"):
        for text in re.findall(r"(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])", data):
            try:
                address = ipaddress.ip_address(text)
                if address.is_private and not address.is_loopback and not address.is_unspecified:
                    errors.append("private address in pipeline")
            except ValueError:
                pass
    return sorted(set(errors))


def main():
    names = json.loads(subprocess.check_output(["node", "-e",
        "console.log(JSON.stringify(require('./tools/source-files.cjs').sourceFiles(process.cwd())))"], cwd=ROOT))
    errors = []
    for name in names:
        data = (ROOT / name).read_bytes()
        if b"\0" in data and name != ARMONEL_REGISTRY_FILE:
            continue
        for finding in findings(name, data.decode("utf-8", errors="replace")):
            errors.append({"file": name, "finding": finding})
    print(json.dumps({"ok": not errors, "files": len(names), "errors": errors}, indent=2))
    return bool(errors)


if __name__ == "__main__":
    raise SystemExit(main())
