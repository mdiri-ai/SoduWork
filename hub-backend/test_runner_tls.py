"""Real loopback WSS verification with no Hub, accounts or external network."""
import ipaddress
import os
import ssl
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import certifi
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve

from app.services import runner_tls


def certificate(directory, *, hostname="localhost"):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, hostname)])
    now = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
        .public_key(key.public_key()).serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=1)).not_valid_after(now + timedelta(days=1))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(hostname),
            *([x509.IPAddress(ipaddress.ip_address("127.0.0.1"))] if hostname == "localhost" else [])]), False)
        .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False,
            key_encipherment=True, data_encipherment=False, key_agreement=False,
            key_cert_sign=True, crl_sign=True, encipher_only=False, decipher_only=False), True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), False)
        .sign(key, hashes.SHA256()))
    cert_path, key_path = directory / "cert.pem", directory / "key.pem"
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert_path, key_path)
    return cert_path, context


class RunnerTLSTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-runner-tls-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        # A clean end-user Mac has neither the CI Python nor Homebrew CA paths.
        env = patch.dict(os.environ, SSL_CERT_FILE=str(self.root / "missing.pem"),
                         SSL_CERT_DIR=str(self.root / "missing-directory"))
        env.start()
        self.addCleanup(env.stop)
        platform = patch.object(runner_tls, "sys", SimpleNamespace(platform="darwin"))
        platform.start()
        self.addCleanup(platform.stop)

    def test_bundle_loads_when_default_ca_paths_do_not_exist(self):
        expected = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        expected.load_verify_locations(cafile=certifi.where())
        context = runner_tls.websocket_options("wss://fixture.invalid")["ssl"]
        self.assertTrue(expected.get_ca_certs(binary_form=True))
        self.assertTrue(set(expected.get_ca_certs(binary_form=True)).issubset(
            context.get_ca_certs(binary_form=True)))
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)

    def test_plaintext_and_other_platforms_keep_existing_transport_defaults(self):
        with patch.object(certifi, "where", side_effect=AssertionError("must not load bundle")):
            self.assertEqual(runner_tls.websocket_options("ws://localhost"), {})
            for platform in ("linux", "win32"):
                with patch.object(runner_tls, "sys", SimpleNamespace(platform=platform)):
                    self.assertEqual(runner_tls.websocket_options("wss://fixture.invalid"), {})

    def test_missing_or_corrupt_bundle_fails_closed(self):
        bad = self.root / "bad.pem"
        bad.write_text("not a certificate")
        for path in (self.root / "missing.pem", bad):
            with self.subTest(path=path), patch.object(certifi, "where", return_value=str(path)):
                with self.assertRaises((OSError, ssl.SSLError)):
                    runner_tls.websocket_options("wss://fixture.invalid")

    async def exchange(self, server_context, *, success):
        async def echo(socket):
            await socket.send(await socket.recv())
        async with serve(echo, "127.0.0.1", 0, ssl=server_context) as server:
            url = f"wss://127.0.0.1:{server.sockets[0].getsockname()[1]}"
            options = runner_tls.websocket_options(url)
            if success:
                async with connect(url, proxy=None, **options) as socket:
                    await socket.send("verified")
                    self.assertEqual(await socket.recv(), "verified")
            else:
                with self.assertRaises(ssl.SSLCertVerificationError):
                    async with connect(url, proxy=None, **options):
                        self.fail("untrusted peer accepted")

    async def test_real_wss_uses_bundled_trust_without_host_ca_files(self):
        cert, context = certificate(self.root)
        with patch.object(certifi, "where", return_value=str(cert)):
            await self.exchange(context, success=True)

    async def test_explicit_private_ca_is_retained_alongside_public_bundle(self):
        cert, context = certificate(self.root)
        with patch.dict(os.environ, SSL_CERT_FILE=str(cert)):
            await self.exchange(context, success=True)

    async def test_untrusted_certificate_is_rejected(self):
        _, context = certificate(self.root)
        await self.exchange(context, success=False)

    async def test_trusted_certificate_for_wrong_hostname_is_rejected(self):
        cert, context = certificate(self.root, hostname="wrong.invalid")
        with patch.object(certifi, "where", return_value=str(cert)):
            await self.exchange(context, success=False)


if __name__ == "__main__":
    unittest.main()
