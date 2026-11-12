"""File boundaries, publisher proofs and immutable caches use the same v2 identity."""
import base64
import hashlib
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import automation_models as am
from app.services import (package_digests, plugin_package_resources, plugin_packages,
                          plugin_service, plugin_signatures, runner_skills,
                          skill_content, skill_packages, skill_read_scope, skill_sharing)

MANIFEST = {"schemaVersion": 1, "key": "file-identity", "version": "1.0.0",
            "name": "File identity", "instructions": "Read reference data only."}
SKILL = b"---\nname: file-identity\ndescription: Read reference data\n---\nRead the references.\n"
SEPARATE = {"references/a.bin": b"X", "references/b.txt": b"Y"}
MERGED = {"references/a.bin": b"X\0references/b.txt\0Y"}


def archive(files, *, reverse=False):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as stream:
        for name, content in sorted(files.items(), reverse=reverse):
            stream.writestr(name, content)
    return buffer.getvalue()


def plugin_files(resources):
    return {"plugin.json": json.dumps(MANIFEST).encode(), **resources}


def legacy_digest(files):
    digest = hashlib.sha256()
    for name, content in sorted(files.items()):
        digest.update(name.encode() + b"\0" + content + b"\0")
    return digest.hexdigest()


class FileIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-file-identity-")
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        for target in ("app.services.skill_packages._data_root", "app.services.runner_skills._data_root",
                       "app.services.local_base._data_root"):
            mock = patch(target, return_value=self.temp.name)
            mock.start()
            self.addCleanup(mock.stop)
        runner_skills._CACHE.clear()
        self.addCleanup(runner_skills._CACHE.clear)

    def test_framing_separates_trees_and_preserves_zip_independence(self):
        self.assertEqual(legacy_digest(SEPARATE), legacy_digest(MERGED))
        first = plugin_packages.parse(archive(plugin_files(SEPARATE)))
        second = plugin_packages.parse(archive(plugin_files(MERGED)))
        self.assertNotEqual(first["checksum"], second["checksum"])
        self.assertNotEqual(first["contentChecksum"], second["contentChecksum"])
        self.assertEqual(first["checksum"], plugin_packages.parse(
            archive(plugin_files(SEPARATE), reverse=True))["checksum"])
        self.assertEqual(first["checksum"], first["contentChecksum"])
        self.assertNotEqual(skill_packages._canonical_digest(SEPARATE),
                            skill_packages._canonical_digest(MERGED))

    def test_skills_with_old_collision_never_share_owner_cache_or_runner_bytes(self):
        rows = []
        for owner, files in (("owner-a", SEPARATE), ("owner-b", MERGED)):
            parsed = skill_packages.parse(archive({"SKILL.md": SKILL, **files}))
            row = skill_packages.install(parsed, "personal", owner)
            rows.append(row)
            self.assertEqual(skill_content.read_files(row["path"]), parsed["files"])
            self.assertEqual(row["fileCount"], len(parsed["files"]))
        self.assertNotEqual(rows[0]["path"], rows[1]["path"])
        first, second = (runner_skills.build([row]) for row in rows)
        self.assertNotEqual(first, second)
        for row, bundle in zip(rows, (first, second)):
            installed = runner_skills.install(bundle)
            self.assertEqual(skill_content.read_files(installed[0]["path"]),
                             skill_content.read_files(row["path"]))

    def test_old_skill_pointer_fails_closed_and_reimport_preserves_original(self):
        content = {"SKILL.md": SKILL, **SEPARATE}
        checksum = legacy_digest(content)
        folder = Path(skill_packages.root(), "packages", checksum, "file-identity")
        for name, value in content.items():
            target = folder / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(value)
        (folder / ".ready").write_text(checksum)
        row = {"name": "file-identity", "description": "Read reference data", "scope": "personal",
               "ownerClientId": "owner-a", "packageChecksum": checksum, "path": str(folder), "bundled": True}
        skill_packages._save_index({"schemaVersion": 1, "items": [row]})
        index = Path(skill_packages._index_path()).read_bytes()
        active = skill_packages.active(owner_client_id="owner-a")
        self.assertIn("重新导入", active[0]["identityError"])
        for operation in (lambda: skill_sharing.files(row), lambda: runner_skills.build([row]),
                          lambda: skill_read_scope.localize([row], [row])):
            with self.assertRaisesRegex(ValueError, "重新导入"):
                operation()
        self.assertEqual(Path(skill_packages._index_path()).read_bytes(), index)
        new = skill_packages.install(skill_packages.parse(archive(content)), "personal", "owner-a")
        self.assertNotEqual(new["path"], str(folder))
        self.assertEqual(skill_content.read_files(str(folder)), content)
        self.assertEqual((folder / ".ready").read_text(), checksum)
        self.assertNotIn("identityError", skill_packages.active(owner_client_id="owner-a")[0])

    def test_old_plugin_checksum_cannot_load_resources_or_cached_skills(self):
        files = plugin_files({"skills/file-identity/SKILL.md": SKILL})
        data, checksum = archive(files), legacy_digest(files)
        package = self.root / "original.soduwork-plugin"
        package.write_bytes(data)
        parsed = plugin_packages.parse(data)
        version = SimpleNamespace(package_path=str(package), checksum=checksum, manifest=parsed["manifest"],
                                  provenance={}, capability_report=parsed["capabilities"])
        with self.assertRaisesRegex(ValueError, "重新导入"):
            plugin_package_resources.for_version(version)
        old = self.root / "plugin-skills" / checksum
        old.mkdir(parents=True)
        (old / ".ready").write_text(checksum)
        (old / "SKILL.md").write_bytes(SKILL)
        with self.assertRaisesRegex(ValueError, "重新导入"):
            plugin_packages.materialize_skills(str(package), checksum, parsed["capabilities"])
        self.assertIsNone(skill_read_scope._cache_hit({"name": "file-identity", "pluginChecksum": checksum}))
        self.assertEqual(package.read_bytes(), data)
        self.assertEqual((old / ".ready").read_text(), checksum)

    def test_reimport_does_not_overwrite_modified_current_cache(self):
        parsed = skill_packages.parse(archive({"SKILL.md": SKILL, **SEPARATE}))
        row = skill_packages.install(parsed, "personal", "owner-a")
        resource = Path(row["path"], "references/a.bin")
        resource.write_bytes(b"local modification")
        with self.assertRaisesRegex(ValueError, "原文件已保留"):
            skill_packages.install(parsed, "personal", "owner-b")
        self.assertEqual(resource.read_bytes(), b"local modification")

    def test_old_persisted_proof_is_not_presented_as_verified(self):
        self.assertEqual(plugin_service.provenance_api({"signatureState": "verified"})[
            "signatureState"], "legacy-signature")
        self.assertEqual(plugin_service.provenance_api({"signatureState": "verified",
            "digestAlgorithm": package_digests.ALGORITHM})["signatureState"], "verified")

    def test_runner_stops_reading_sources_as_soon_as_aggregate_limit_is_exceeded(self):
        items = [{"name": str(number), "path": self.temp.name, "bundled": True} for number in range(3)]
        for limit in ("_MAX_BYTES", "_MAX_FILES"):
            with self.subTest(limit=limit), patch.object(runner_skills, limit, 1), patch.object(
                    skill_content, "read_files", return_value={"SKILL.md": b"x"}) as reader:
                with self.assertRaisesRegex(ValueError, "30MB"):
                    runner_skills.build(items)
                self.assertEqual(reader.call_count, 2)


class PublisherFileIdentityTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as connection:
            await connection.run_sync(am.PluginPublisherKey.__table__.create)
        self.session = async_sessionmaker(self.engine, expire_on_commit=False)()
        self.private = Ed25519PrivateKey.generate()
        raw = self.private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        self.session.add(am.PluginPublisherKey(key_id="identity-test", publisher_name="Fixture publisher",
            public_key=base64.b64encode(raw).decode(), fingerprint=hashlib.sha256(raw).hexdigest(), status="active"))
        await self.session.commit()

    async def asyncTearDown(self):
        await self.session.close()
        await self.engine.dispose()

    def signed(self, files):
        parsed = plugin_packages.parse(archive(files))
        payload = plugin_signatures.prepare_payload(parsed, "identity-test", "2026-11-12T00:00:00Z")
        envelope = {name: payload[name] for name in ("schema", "algorithm", "keyId", "signedAt")}
        envelope["signature"] = base64.b64encode(self.private.sign(
            plugin_signatures.canonical_bytes(payload))).decode()
        return envelope

    async def test_valid_signature_rejects_boundary_change_and_regular_tampering(self):
        original = plugin_files(SEPARATE)
        signature = json.dumps(self.signed(original)).encode()
        for files, expected in ((original, "verified"), (plugin_files(MERGED), "invalid"),
                                (plugin_files({**SEPARATE, "references/b.txt": b"Z"}), "invalid")):
            with self.subTest(expected=expected, resources=len(files)):
                parsed = plugin_packages.parse(archive({**files, plugin_signatures.SIGNATURE_PATH: signature}))
                proof = await plugin_signatures.inspect(self.session, parsed, None)
                self.assertEqual(proof["state"], expected)
                if expected == "invalid":
                    with self.assertRaises(ValueError):
                        plugin_signatures.assert_importable(proof)

    async def test_legacy_signature_requires_explicit_resigning(self):
        files = plugin_files(SEPARATE)
        envelope = self.signed(files)
        envelope["schema"] = "soduwork.plugin-signature/v1"
        payload = plugin_signatures.signature_payload(legacy_digest(files), MANIFEST, envelope)
        payload["schema"] = envelope["schema"]
        envelope["signature"] = base64.b64encode(self.private.sign(
            plugin_signatures.canonical_bytes(payload))).decode()
        for resources in (SEPARATE, MERGED):
            with self.assertRaisesRegex(ValueError, "重新签发 v2"):
                plugin_packages.parse(archive({**plugin_files(resources), plugin_signatures.SIGNATURE_PATH:
                                               json.dumps(envelope).encode()}))


if __name__ == "__main__":
    unittest.main()
