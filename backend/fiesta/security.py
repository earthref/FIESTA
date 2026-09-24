from datetime import UTC, datetime, timedelta

import bcrypt
import jwt

from fiesta.settings import get_settings

ALGORITHM = "HS256"


def _secret(password: str) -> bytes:
    # bcrypt reads 72 bytes; the legacy apps (bcryptjs) truncated silently, bcrypt 5 raises.
    return password.encode()[:72]


def hash_password(password: str) -> str:
    return bcrypt.hashpw(_secret(password), bcrypt.gensalt()).decode()


def verify_password(password: str, password_hash: str | None) -> bool:
    """Check a bcrypt hash, including the legacy er_users `$2a$`/`$2y$` ones."""
    if not password_hash:
        return False
    try:
        return bcrypt.checkpw(_secret(password), password_hash.encode())
    except ValueError:
        return False


def create_access_token(user_id: int) -> str:
    settings = get_settings()
    payload = {
        "sub": str(user_id),
        "exp": datetime.now(UTC) + timedelta(minutes=settings.access_token_expire_minutes),
    }
    return jwt.encode(payload, settings.secret_key, algorithm=ALGORITHM)


def decode_access_token(token: str) -> int | None:
    try:
        payload = jwt.decode(token, get_settings().secret_key, algorithms=[ALGORITHM])
        return int(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        return None
