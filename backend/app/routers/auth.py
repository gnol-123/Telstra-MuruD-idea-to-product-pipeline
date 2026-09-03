"""Authentication endpoints backed by Supabase Auth."""

import logging
from functools import lru_cache
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, EmailStr, Field
from supabase import ClientOptions, create_client

from app.config import settings
from app.services.supabase import get_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])

bearer_scheme = HTTPBearer(auto_error=False)


# Pydantic models for validation of request and response bodies.
class SignUpRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


class RefreshRequest(BaseModel):
    refresh_token: str


class PasswordResetRequest(BaseModel):
    email: EmailStr


class UserResponse(BaseModel):
    id: str
    email: str | None = None


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int | None = None
    user: UserResponse


def _credentials_error(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


async def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
) -> UserResponse:
    """Get current user from a bearer token.

    Add ``user: Annotated[UserResponse, Depends(get_current_user)]`` to any
    route to require authentication.
    """
    if credentials is None:
        raise _credentials_error("Not authenticated")

    try:
        response = get_client().auth.get_user(credentials.credentials)
    except Exception as exc:  # noqa: BLE001 - any auth failure is a 401
        raise _credentials_error("Invalid or expired token") from exc

    if response is None or response.user is None:
        raise _credentials_error("Invalid or expired token")

    return UserResponse(id=str(response.user.id), email=response.user.email)


CurrentUser = Annotated[UserResponse, Depends(get_current_user)]


@router.post("/signup", status_code=status.HTTP_201_CREATED)
def signup(req: SignUpRequest) -> dict[str, str]:
    """Register a user.

    Supabase will send a confirmation email to the user.

    Note for the frontend dev: Supabase does not allow signing in until the
    email is confirmed, so the user will need to check their email before
    logging in.
    """
    try:
        response = get_client().auth.sign_up({"email": req.email, "password": req.password})
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    if response.user is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Sign up failed")

    return {"message": "Sign up successful. Check your email to confirm your account."}


@router.post("/login", response_model=TokenResponse)
def login(req: LoginRequest) -> TokenResponse:
    """Login a user and return access and refresh tokens."""
    try:
        response = get_client().auth.sign_in_with_password(
            {"email": req.email, "password": req.password}
        )
    except Exception as exc:
        raise _credentials_error("Invalid email or password") from exc

    if response.session is None or response.user is None:
        raise _credentials_error("Invalid email or password")

    return TokenResponse(
        access_token=response.session.access_token,
        refresh_token=response.session.refresh_token,
        expires_in=response.session.expires_in,
        user=UserResponse(id=str(response.user.id), email=response.user.email),
    )


@router.post("/refresh", response_model=TokenResponse)
def refresh(req: RefreshRequest) -> TokenResponse:
    """Refresh an access token using a refresh token."""
    try:
        response = get_client().auth.refresh_session(req.refresh_token)
    except Exception as exc:
        raise _credentials_error("Invalid or expired refresh token") from exc

    if response.session is None or response.user is None:
        raise _credentials_error("Invalid or expired refresh token")

    return TokenResponse(
        access_token=response.session.access_token,
        refresh_token=response.session.refresh_token,
        expires_in=response.session.expires_in,
        user=UserResponse(id=str(response.user.id), email=response.user.email),
    )


@router.get("/me", response_model=UserResponse)
def me(user: CurrentUser) -> UserResponse:
    return user


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(user: CurrentUser) -> None:
    """Best-effort revocation.

    Requiring a valid token stops unauthenticated callers from poking this.
    Clients should still discard both tokens locally.
    """
    try:
        get_client().auth.sign_out()
    except Exception:
        logger.warning("sign_out failed for user %s", user.id, exc_info=True)


@router.post("/password-reset", status_code=status.HTTP_202_ACCEPTED)
def password_reset(req: PasswordResetRequest) -> dict[str, str]:
    """Send a reset email.

    Always reports success, even for unknown addresses, so this cannot be used
    to test whether an email is registered.
    """
    try:
        get_client().auth.reset_password_email(req.email)
    except Exception:
        logger.warning("password reset email failed", exc_info=True)

    return {"message": "If that email is registered, a reset link has been sent."}


@lru_cache
def _oauth_client():
    """Separate client pinned to the implicit flow.

    The shared ``get_client()`` defaults to PKCE, which returns a ``?code=``
    that must be exchanged using the same ``code_verifier`` that generated it.
    That verifier lives on the client instance, and ours is a process-wide
    singleton, so concurrent sign-ins would overwrite each other's verifier.

    The implicit flow sidesteps that: Supabase returns the session directly in
    the URL fragment, with no server-side state to keep.
    """
    return create_client(
        settings.supabase_url,
        settings.supabase_key,
        options=ClientOptions(flow_type="implicit"),
    )


class OAuthUrlResponse(BaseModel):
    url: str
    provider: str = "google"


@router.get("/login/google", response_model=OAuthUrlResponse)
def google_login(redirect_to: str | None = None) -> OAuthUrlResponse:
    """Start Google sign-in.

    Returns the Google consent URL; the frontend sends the browser there. After
    the user approves, Supabase redirects back to ``redirect_to`` with the
    session in the URL *fragment* (``#access_token=...``).

    The fragment is deliberate: browsers never send it to the server, so tokens
    stay in the client. The frontend reads them with ``window.location.hash``
    and then uses the existing ``/auth/*`` endpoints unchanged.
    """
    target = redirect_to or settings.oauth_redirect_url
    if not target:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="OAUTH_REDIRECT_URL is not configured",
        )

    try:
        response = _oauth_client().auth.sign_in_with_oauth(
            {"provider": "google", "options": {"redirect_to": target}}
        )
    except Exception as exc:
        logger.warning("google sign-in could not start", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Could not start Google sign-in",
        ) from exc

    if not response.url:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Could not start Google sign-in",
        )

    return OAuthUrlResponse(url=response.url, provider="google")
