"""Signed state for the OAuth connect flow, and the token exchange contract.

State carries node_id and owner_id so the callback knows which node is being
authorised and who it belongs to. Signed with oauth_state_secret, short TTL.
"""

import base64
import hashlib
import hmac
import json
import time
from dataclasses import dataclass

from app.config import settings

STATE_TTL_SECONDS = 600


class InvalidStateError(Exception):
    """Bad signature, malformed payload, or expired state."""


def _b64encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64decode(text: str) -> bytes:
    padded = text + "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii"))


def _require_secret() -> str:
    if not settings.oauth_state_secret:
        raise RuntimeError("OAUTH_STATE_SECRET must be set to use the oauth connect flow.")
    return settings.oauth_state_secret


def _signature(payload_b64: str, key: str) -> str:
    digest = hmac.new(key.encode("utf-8"), payload_b64.encode("ascii"), hashlib.sha256).digest()
    return _b64encode(digest)


def sign_state(node_id: str, owner_id: str) -> str:
    """Build a signed, expiring state token for the given node and owner."""
    key = _require_secret()
    payload = {
        "node_id": node_id,
        "owner_id": owner_id,
        "exp": time.time() + STATE_TTL_SECONDS,
    }
    payload_b64 = _b64encode(json.dumps(payload).encode("utf-8"))
    return f"{payload_b64}.{_signature(payload_b64, key)}"


def verify_state(state: str) -> tuple[str, str]:
    """Verify signature and expiry, return (node_id, owner_id) or raise."""
    key = _require_secret()
    try:
        payload_b64, given_sig = state.split(".", 1)
    except ValueError as exc:
        raise InvalidStateError("malformed state") from exc

    expected_sig = _signature(payload_b64, key)
    if not hmac.compare_digest(given_sig, expected_sig):
        raise InvalidStateError("bad state signature")

    try:
        payload = json.loads(_b64decode(payload_b64))
    except (ValueError, UnicodeDecodeError) as exc:
        raise InvalidStateError("malformed state payload") from exc

    if time.time() > payload.get("exp", 0):
        raise InvalidStateError("state expired")

    node_id = payload.get("node_id")
    owner_id = payload.get("owner_id")
    if not node_id or not owner_id:
        raise InvalidStateError("malformed state payload")
    return node_id, owner_id


@dataclass(frozen=True)
class TokenSet:
    access_token: str
    refresh_token: str | None
    expires_at: float
