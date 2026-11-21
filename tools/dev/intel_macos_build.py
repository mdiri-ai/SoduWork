"""Read-only source-build checks for the pinned cryptography on Intel macOS."""
from __future__ import annotations

import os
import platform
import re
import shlex
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit


def output(command: list[str], env: dict, *, source: str | None = None) -> str:
    try:
        result = subprocess.run(command, env=env, input=source, stdin=subprocess.DEVNULL if source is None else None,
                                stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, text=True, errors="replace", timeout=8)
        return result.stdout.strip() if result.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def library_arches(library: Path, env: dict) -> list[str]:
    args = ["-archs", str(library)]
    # Some Apple Silicon installations only ship the arm64 developer tools.
    # The native fallback only reads the given Mach-O file's slice table.
    for tool in (["xcrun", "lipo"], ["/usr/bin/lipo"], ["/usr/bin/arch", "-arm64", "/usr/bin/xcrun", "lipo"]):
        arches = output([*tool, *args], env).split()
        if arches:
            return arches
    return []


def compiler_ready(env: dict) -> bool:
    cc = env.get("CC_x86_64-apple-darwin") or env.get("CC_x86_64_apple_darwin") or env.get("CC")
    if not cc and not env.get("SDKROOT"):
        # A native arm64 launcher can reuse an Intel venv. Query the default
        # tools exactly as that instance's pip child would see them.
        xcrun = ["/usr/bin/arch", "-x86_64", "/usr/bin/xcrun"] if platform.machine().lower() in {"arm64", "aarch64"} else ["xcrun"]
        return bool(output([*xcrun, "--find", "clang"], env) and output([*xcrun, "--show-sdk-path"], env))
    # Check the explicitly selected compiler and SDK together. An arm64-only
    # default configuration must not satisfy the Intel Python build check.
    source = ("#include <stdlib.h>\n#include <TargetConditionals.h>\n"
              "#if !defined(__x86_64__) || !TARGET_OS_OSX\n#error wrong target\n#endif\nSODUWORK_INTEL_SDK\n")
    try:
        compiler = [cc] if cc and Path(cc).is_file() else shlex.split(cc or "cc")
        flags = shlex.split(env.get("ARCHFLAGS", ""))
    except ValueError:
        return False
    if not compiler:
        return False
    sdk = ["-isysroot", env["SDKROOT"]] if env.get("SDKROOT") else []
    return output([*compiler, *flags, *sdk, "-E", "-P", "-x", "c", "-o", "-", "-"], env,
                  source=source).endswith("SODUWORK_INTEL_SDK")


def explicit_wheel_source(env: dict) -> bool:
    if env.get("PIP_FIND_LINKS", "").strip():
        return True
    if env.get("PIP_NO_INDEX", "").lower() not in ("", "0", "false", "no", "off"):
        return False
    for spec in (env.get("PIP_INDEX_URL", ""), env.get("PIP_EXTRA_INDEX_URL", "")):
        for value in spec.split():
            try:
                address = urlsplit(value)
                if address.scheme == "file" or (address.hostname and address.hostname not in {"pypi.org", "pypi.python.org"}):
                    return True
            except ValueError:
                continue
    return False


def openssl_development_files(env: dict) -> bool:
    # openssl-sys gives target-specific variables precedence over the generic ones.
    def setting(key):
        return env.get("X86_64_APPLE_DARWIN_" + key) or env.get(key)

    prefix, include, lib = (setting(name) for name in ("OPENSSL_DIR", "OPENSSL_INCLUDE_DIR", "OPENSSL_LIB_DIR"))
    candidates = []
    if prefix or (include and lib):
        candidates.append((Path(include or Path(prefix) / "include"), Path(lib or Path(prefix) / "lib")))
    else:
        # These are supported discovery paths in openssl-sys on Intel macOS.
        for base in ("/usr/local/opt/openssl@3", "/opt/local", output(["brew", "--prefix", "openssl@3"], env)):
            if base:
                candidates.append((Path(include or Path(base) / "include"), Path(lib or Path(base) / "lib")))
        inc = output(["pkg-config", "--variable=includedir", "openssl"], env)
        libs = output(["pkg-config", "--variable=libdir", "openssl"], env)
        if inc and libs:
            candidates.append((Path(include or inc), Path(lib or libs)))
    for headers, libraries in candidates:
        version_file = headers / "openssl/opensslv.h"
        if not (headers / "openssl/ssl.h").is_file() or not version_file.is_file():
            continue
        major = re.search(r"^\s*#\s*define\s+OPENSSL_VERSION_MAJOR\s+(\d+)\b",
                          version_file.read_text(encoding="ascii", errors="ignore"), re.MULTILINE)
        if not major or int(major[1]) < 3:
            continue
        for suffix in ((".a",) if env.get("OPENSSL_STATIC") == "1" else (".dylib", ".a")):
            pair = [libraries / (name + suffix) for name in ("libssl", "libcrypto")]
            if all(lib.is_file() and "x86_64" in library_arches(lib, env)
                   for lib in pair):
                return True
    return False


def build_gaps(env: dict) -> list[str]:
    missing = []
    # A rustup shim without a selected, installed toolchain is not a compiler.
    probes = dict(env, RUSTUP_AUTO_INSTALL="0")
    rustc = env.get("RUSTC") or "rustc"
    cargo = env.get("CARGO") or "cargo"
    rust = re.search(r"^rustc (\d+)\.(\d+)\.(\d+)\b", output([rustc, "--version"], probes))
    if not rust or tuple(map(int, rust.groups())) < (1, 83, 0):
        missing.append("rustc >= 1.83.0")
    else:
        target = output([rustc, "--print", "target-libdir", "--target", "x86_64-apple-darwin"], probes)
        if not target or not any(Path(target).glob("libstd-*.rlib")):
            missing.append("Rust x86_64-apple-darwin target")
    if not re.match(r"^cargo \d+\.\d+\.\d+\b", output([cargo, "--version"], probes)):
        missing.append("Cargo")
    if not compiler_ready(env):
        missing.append("Xcode Command Line Tools (Clang + macOS SDK)")
    if not openssl_development_files(env):
        missing.append("OpenSSL development headers and libraries (openssl@3)")
    return missing


def installed_snapshot(python: Path, env: dict) -> tuple[str, str]:
    """Inspect a prepared instance without executing its interpreter or .pth files."""
    venv = python.parent.parent
    cfg = venv / "pyvenv.cfg"
    if not (venv.parent / "local-service.json").is_file() or not cfg.is_file():
        return "", ""
    binary = output(["/usr/bin/file", "-Lb", str(python)], env)
    arches = set(re.findall(r"\b(?:arm64|x86_64)\b", binary))
    if not arches:
        return "", ""
    arch = platform.machine().lower() if len(arches) > 1 else arches.pop()
    with cfg.open("rb") as stream:
        version = re.search(rb"^version\s*=\s*(\d+\.\d+)\.", stream.read(8192), re.MULTILINE)
    if not version or arch != "x86_64":
        return arch, ""
    packages = venv / "lib" / ("python" + version[1].decode("ascii")) / "site-packages"
    for binding in (packages / "cryptography/hazmat/bindings").glob("_rust*.so"):
        if binding.is_file() and "x86_64" in output(["/usr/bin/file", "-Lb", str(binding)], env):
            for metadata in packages.glob("cryptography-*.dist-info/METADATA"):
                if metadata.is_file():
                    with metadata.open("rb") as stream:
                        match = re.search(rb"^Version: ([\w.]+)\r?$", stream.read(16384), re.MULTILINE)
                    if match:
                        return arch, match[1].decode("ascii")
    return arch, ""


def requirements_for(python: Path | None, requirements: Path, env: dict, *, read_only: bool = False) -> tuple[str, list[str]]:
    if sys.platform != "darwin":
        return "", []
    arch = platform.machine().lower()
    installed = ""
    if read_only and python is not None and python.is_file():
        try:
            saved_arch, installed = installed_snapshot(python, env)
            arch = saved_arch or arch
        except OSError:
            pass  # An incomplete instance has no usable installation evidence.
    elif python is not None and python.is_file():
        # The instance can run a different Python architecture than its launcher.
        arch = output([str(python), "-I", "-B", "-c", "import platform; print(platform.machine())"], env).lower() or arch
    if arch not in {"x86_64", "amd64"}:
        return "", []
    match = re.search(r"^cryptography==([\w.]+)\s*$", requirements.read_text(encoding="utf-8"), re.MULTILINE)
    if not match:
        raise ValueError("Missing cryptography pin in " + str(requirements))
    pin = "cryptography==" + match[1]
    if not read_only and python is not None and python.is_file():
        installed = output([str(python), "-I", "-B", "-c",
                            "import cryptography; from cryptography.hazmat.bindings._rust import openssl; "
                            "print(cryptography.__version__)"], env)
    if installed == match[1]:
        return "", []
    return pin, build_gaps(env)


def instructions(pin: str, gaps: list[str]) -> str:
    return (f"Intel macOS (x86_64 Python), {pin}: 缺少源码编译工具 / Missing build prerequisites: "
            + ", ".join(gaps) + ".\n"
            "安装缺失项后重跑 / Install the missing tools, then rerun the launcher: "
            "Run xcode-select --install. With Intel Homebrew, run brew install rust openssl@3. "
            'For a custom OpenSSL installation, set OPENSSL_DIR to its Intel prefix. '
            '也可使用可信的匹配 wheel / A trusted matching wheel can be supplied through pip.')
