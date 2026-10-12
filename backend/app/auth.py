"""Supabase access-token verification for protected API routes."""

import jwt
from fastapi import Header, HTTPException
from jwt import PyJWKClient, PyJWKClientConnectionError, PyJWKClientError

from .config import settings

_jwks_client: PyJWKClient | None = None


def auth_required() -> bool:
    return True


def auth_configured() -> bool:
    return bool(settings.supabase_url)


def require_auth(authorization: str = Header(default="")) -> None:
    if not settings.supabase_url:
        raise HTTPException(503, "Supabase authentication is not configured")

    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise HTTPException(401, "Not signed in")

    issuer = f"{settings.supabase_url}/auth/v1"
    try:
        if settings.supabase_jwt_secret:
            jwt.decode(
                token.strip(),
                settings.supabase_jwt_secret,
                algorithms=["HS256"],
                audience="authenticated",
                issuer=issuer,
            )
        else:
            global _jwks_client
            if _jwks_client is None:
                _jwks_client = PyJWKClient(
                    f"{issuer}/.well-known/jwks.json",
                    cache_keys=True,
                    timeout=5,
                )
            signing_key = _jwks_client.get_signing_key_from_jwt(token.strip())
            jwt.decode(
                token.strip(),
                signing_key.key,
                algorithms=["ES256", "RS256", "EdDSA"],
                audience="authenticated",
                issuer=issuer,
            )
    except PyJWKClientConnectionError as exc:
        raise HTTPException(503, "Unable to reach Supabase to verify your session") from exc
    except (jwt.PyJWTError, PyJWKClientError) as exc:
        raise HTTPException(401, "Not signed in") from exc
