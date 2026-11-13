"""Verify CA data and its loader in the actual PyInstaller Runner artifact."""
import ssl
import sys
from pathlib import Path

import certifi
from PyInstaller.archive.readers import CArchiveReader


def check(binary):
    archive = CArchiveReader(str(binary))
    bundled = archive.extract("certifi/cacert.pem")
    if bundled != Path(certifi.where()).read_bytes():
        raise AssertionError("Frozen Runner CA bundle differs from the pinned dependency")
    modules = archive.open_embedded_archive("PYZ.pyz").toc
    if not {"certifi", "certifi.core", "app.services.runner_tls"}.issubset(modules):
        raise AssertionError("Frozen Runner is missing its CA loader")
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.load_verify_locations(cadata=bundled.decode("ascii"))
    count = len(context.get_ca_certs())
    if not count:
        raise AssertionError("Frozen Runner CA bundle contains no trust anchors")
    print(f"PASS frozen Runner CA bundle and loader ({count} trust anchors)")


if __name__ == "__main__":
    check(Path(sys.argv[1]))
