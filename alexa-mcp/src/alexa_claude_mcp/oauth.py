"""OAuth 2.1 authorization server for the Alexa+ MCP add-on.

Alexa+ connects as an MCP client and runs the authorization code flow with PKCE (S256)
against this server before it may call a tool. The MCP SDK owns the endpoints
(`/authorize`, `/token`, `/register`, `/revoke`) and verifies PKCE, redirect_uri reuse
and code expiry; this module owns storage, the consent screen and token issuance.

The resource owner is whoever knows ALEXA_MCP_LOGIN_PASSWORD - this is a personal add-on,
so there is one account and the passcode entered on the consent screen is the login.
"""

from __future__ import annotations

import hmac
import logging
import secrets
import time
from typing import Any

from mcp.server.auth.provider import (
    AccessToken,
    AuthorizationCode,
    AuthorizationParams,
    AuthorizeError,
    OAuthAuthorizationServerProvider,
    RefreshToken,
    RegistrationError,
    TokenError,
    construct_redirect_uri,
)
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken
from pydantic import AnyUrl

from .config import Config
from .storage import Store

logger = logging.getLogger(__name__)

SUBJECT = "owner"


class AlexaOAuthProvider(OAuthAuthorizationServerProvider[AuthorizationCode, RefreshToken, AccessToken]):
    """Authorization server backed by the SQLite store."""

    def __init__(self, config: Config, store: Store) -> None:
        self._config = config
        self._store = store
        if config.static_client_id:
            self._store.save_client(
                config.static_client_id,
                OAuthClientInformationFull(
                    client_id=config.static_client_id,
                    client_secret=config.static_client_secret,
                    redirect_uris=[AnyUrl(uri) for uri in config.static_redirect_uris],
                    grant_types=["authorization_code", "refresh_token"],
                    response_types=["code"],
                    scope=" ".join(config.scopes),
                    token_endpoint_auth_method=(
                        "client_secret_post" if config.static_client_secret else "none"
                    ),
                ).model_dump(mode="json", exclude_none=True),
            )

    # --- client registration ---------------------------------------------

    async def get_client(self, client_id: str) -> OAuthClientInformationFull | None:
        payload = self._store.get_client(client_id)
        if payload is None:
            return None
        return OAuthClientInformationFull.model_validate(payload)

    async def register_client(self, client_info: OAuthClientInformationFull) -> None:
        for redirect_uri in client_info.redirect_uris or []:
            if not self._config.redirect_uri_allowed(str(redirect_uri)):
                raise RegistrationError(
                    error="invalid_redirect_uri",
                    error_description=(
                        f"redirect_uri host is not allowed: {redirect_uri}. Add it to "
                        "ALEXA_MCP_ALLOWED_REDIRECT_HOSTS if you trust it."
                    ),
                )
        self._store.save_client(
            client_info.client_id, client_info.model_dump(mode="json", exclude_none=True)
        )
        logger.info("registered oauth client %s (%s)", client_info.client_id, client_info.client_name)

    # --- authorization ----------------------------------------------------

    async def authorize(self, client: OAuthClientInformationFull, params: AuthorizationParams) -> str:
        """Park the request and send the browser to our consent screen."""
        if not self._config.redirect_uri_allowed(str(params.redirect_uri)):
            raise AuthorizeError(
                error="invalid_request",
                error_description=f"redirect_uri host is not allowed: {params.redirect_uri}",
            )
        request_id = self._store.create_login_request(
            {
                "client_id": client.client_id,
                "client_name": client.client_name or client.client_id,
                "redirect_uri": str(params.redirect_uri),
                "redirect_uri_provided_explicitly": params.redirect_uri_provided_explicitly,
                "code_challenge": params.code_challenge,
                "state": params.state,
                "scopes": params.scopes or list(self._config.scopes),
                "resource": params.resource,
            },
            ttl=self._config.login_window_ttl,
        )
        return f"{self._config.public_url}/login?request_id={request_id}"

    def complete_login(self, request_id: str, password: str) -> tuple[str | None, str]:
        """Check the passcode and mint an authorization code.

        Returns (redirect_url, error_message). On a wrong passcode the redirect is None and
        the caller re-renders the form with the message.
        """
        pending = self._store.get_login_request(request_id)
        if pending is None:
            return None, "Sessão de autorização expirada. Recomece a conexão no Alexa+."
        payload, attempts = pending
        if attempts >= self._config.max_login_attempts:
            self._store.delete_login_request(request_id)
            return None, "Número de tentativas excedido. Recomece a conexão no Alexa+."
        if not hmac.compare_digest(password, self._config.login_password):
            self._store.bump_login_attempts(request_id)
            return None, "Senha incorreta."

        self._store.delete_login_request(request_id)
        code = secrets.token_urlsafe(32)
        self._store.save_auth_code(
            code,
            {
                "code": code,
                "client_id": payload["client_id"],
                "redirect_uri": payload["redirect_uri"],
                "redirect_uri_provided_explicitly": payload["redirect_uri_provided_explicitly"],
                "code_challenge": payload["code_challenge"],
                "scopes": payload["scopes"],
                "resource": payload.get("resource"),
                "subject": SUBJECT,
            },
            expires_at=time.time() + self._config.auth_code_ttl,
        )
        redirect = construct_redirect_uri(payload["redirect_uri"], code=code, state=payload.get("state"))
        return redirect, ""

    def denied_redirect(self, request_id: str) -> str | None:
        """Build the `access_denied` redirect for the Cancel button."""
        pending = self._store.get_login_request(request_id)
        if pending is None:
            return None
        payload, _ = pending
        self._store.delete_login_request(request_id)
        return construct_redirect_uri(
            payload["redirect_uri"],
            error="access_denied",
            error_description="Authorization denied by the resource owner",
            state=payload.get("state"),
        )

    def pending_client_name(self, request_id: str) -> str | None:
        pending = self._store.get_login_request(request_id)
        return pending[0].get("client_name") if pending else None

    # --- code and token exchange -------------------------------------------

    async def load_authorization_code(
        self, client: OAuthClientInformationFull, authorization_code: str
    ) -> AuthorizationCode | None:
        payload = self._store.peek_auth_code(authorization_code)
        if payload is None or payload["client_id"] != client.client_id:
            return None
        return AuthorizationCode(
            code=payload["code"],
            scopes=payload["scopes"],
            expires_at=time.time() + self._config.auth_code_ttl,
            client_id=payload["client_id"],
            code_challenge=payload["code_challenge"],
            redirect_uri=AnyUrl(payload["redirect_uri"]),
            redirect_uri_provided_explicitly=payload["redirect_uri_provided_explicitly"],
            resource=payload.get("resource"),
            subject=payload.get("subject", SUBJECT),
        )

    async def exchange_authorization_code(
        self, client: OAuthClientInformationFull, authorization_code: AuthorizationCode
    ) -> OAuthToken:
        if self._store.pop_auth_code(authorization_code.code) is None:
            raise TokenError(error="invalid_grant", error_description="authorization code already used")
        return self._issue_tokens(
            client_id=client.client_id,
            scopes=authorization_code.scopes,
            resource=authorization_code.resource,
            subject=authorization_code.subject or SUBJECT,
        )

    async def load_refresh_token(
        self, client: OAuthClientInformationFull, refresh_token: str
    ) -> RefreshToken | None:
        payload = self._store.get_token(refresh_token, "refresh")
        if payload is None or payload["client_id"] != client.client_id:
            return None
        return RefreshToken(**payload)

    async def exchange_refresh_token(
        self,
        client: OAuthClientInformationFull,
        refresh_token: RefreshToken,
        scopes: list[str],
    ) -> OAuthToken:
        requested = scopes or refresh_token.scopes
        if not set(requested).issubset(set(refresh_token.scopes)):
            raise TokenError(error="invalid_scope", error_description="cannot widen scope on refresh")
        # Rotate: the presented refresh token dies with this exchange.
        self._store.delete_token(refresh_token.token)
        return self._issue_tokens(
            client_id=client.client_id,
            scopes=requested,
            resource=refresh_token.resource,
            subject=refresh_token.subject or SUBJECT,
        )

    async def load_access_token(self, token: str) -> AccessToken | None:
        payload = self._store.get_token(token, "access")
        if payload is None:
            return None
        return AccessToken(**payload)

    async def revoke_token(self, token: AccessToken | RefreshToken) -> None:
        self._store.delete_token(token.token)

    # --- helpers -----------------------------------------------------------

    def _issue_tokens(
        self, *, client_id: str, scopes: list[str], resource: str | None, subject: str
    ) -> OAuthToken:
        now = int(time.time())
        access_token = secrets.token_urlsafe(32)
        refresh_token = secrets.token_urlsafe(32)
        access_expires = now + self._config.access_token_ttl
        refresh_expires = now + self._config.refresh_token_ttl

        access_payload: dict[str, Any] = {
            "token": access_token,
            "client_id": client_id,
            "scopes": scopes,
            "expires_at": access_expires,
            "resource": resource,
            "subject": subject,
        }
        refresh_payload: dict[str, Any] = {
            "token": refresh_token,
            "client_id": client_id,
            "scopes": scopes,
            "expires_at": refresh_expires,
            "resource": resource,
            "subject": subject,
        }
        self._store.save_token(access_token, "access", access_payload, access_expires)
        self._store.save_token(refresh_token, "refresh", refresh_payload, refresh_expires)
        self._store.purge_expired()
        return OAuthToken(
            access_token=access_token,
            token_type="Bearer",
            expires_in=self._config.access_token_ttl,
            scope=" ".join(scopes),
            refresh_token=refresh_token,
        )
