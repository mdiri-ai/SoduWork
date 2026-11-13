"""Portable TLS trust for the standalone macOS Runner control connection."""
import ssl
import sys


def websocket_options(url: str) -> dict:
    if sys.platform != "darwin" or not url.lower().startswith("wss://"):
        return {}
    import certifi

    # Frozen OpenSSL retains the build host's Python/Homebrew CA paths. Keep
    # explicitly configured private CAs, then add the bundle shipped with Runner.
    context = ssl.create_default_context()
    context.load_verify_locations(cafile=certifi.where())
    return {"ssl": context}
