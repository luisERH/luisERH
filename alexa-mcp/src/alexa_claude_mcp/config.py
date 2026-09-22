"""Runtime configuration, read once from the environment."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from urllib.parse import urlparse

DEFAULT_REDIRECT_HOST_SUFFIXES = (
    "amazon.com",
    "amazonalexa.com",
    "alexa.com",
    "amazon.co.uk",
    "localhost",
    "127.0.0.1",
)


class ConfigError(RuntimeError):
    """Raised when the environment is missing something the server cannot run without."""


def _require(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ConfigError(f"missing required environment variable {name}")
    return value


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be an integer, got {raw!r}") from exc


def _csv(name: str) -> tuple[str, ...]:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return ()
    return tuple(item.strip() for item in raw.split(",") if item.strip())


@dataclass(frozen=True)
class Config:
    """Everything the server needs, resolved from environment variables."""

    public_url: str
    login_password: str
    anthropic_api_key: str
    anthropic_model: str = "claude-sonnet-5"
    anthropic_max_tokens: int = 1024
    language: str = "pt-BR"
    max_spoken_chars: int = 600
    history_turns: int = 12
    db_path: str = "data/alexa_mcp.sqlite3"
    host: str = "127.0.0.1"
    port: int = 8080
    access_token_ttl: int = 3600
    refresh_token_ttl: int = 60 * 60 * 24 * 30
    auth_code_ttl: int = 300
    login_window_ttl: int = 600
    max_login_attempts: int = 8
    allowed_redirect_host_suffixes: tuple[str, ...] = DEFAULT_REDIRECT_HOST_SUFFIXES
    static_client_id: str | None = None
    static_client_secret: str | None = None
    static_redirect_uris: tuple[str, ...] = ()
    scopes: tuple[str, ...] = field(default=("claude:ask",))

    @property
    def mcp_url(self) -> str:
        return f"{self.public_url}/mcp"

    @property
    def public_host(self) -> str:
        return urlparse(self.public_url).netloc

    def redirect_uri_allowed(self, redirect_uri: str) -> bool:
        """Allow only redirect URIs whose host is on the allowlist.

        Dynamic client registration is open by design (Alexa+ registers itself), so the
        redirect host is the only thing standing between this server and an attacker
        registering a client that points the authorization code somewhere else.
        """
        if "*" in self.allowed_redirect_host_suffixes:
            return True
        parsed = urlparse(redirect_uri)
        if parsed.scheme not in ("https", "http"):
            return False
        host = (parsed.hostname or "").lower()
        if not host:
            return False
        if parsed.scheme == "http" and host not in ("localhost", "127.0.0.1"):
            return False
        return any(
            host == suffix or host.endswith(f".{suffix}")
            for suffix in self.allowed_redirect_host_suffixes
        )


def load_config() -> Config:
    """Build a Config from the process environment, validating as we go."""
    public_url = _require("ALEXA_MCP_PUBLIC_URL").rstrip("/")
    parsed = urlparse(public_url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ConfigError(f"ALEXA_MCP_PUBLIC_URL must be an absolute http(s) URL, got {public_url!r}")
    if parsed.scheme == "http" and parsed.hostname not in ("localhost", "127.0.0.1"):
        raise ConfigError("ALEXA_MCP_PUBLIC_URL must use https outside of localhost")

    password = _require("ALEXA_MCP_LOGIN_PASSWORD")
    if len(password) < 12:
        raise ConfigError("ALEXA_MCP_LOGIN_PASSWORD must be at least 12 characters")

    allowlist = _csv("ALEXA_MCP_ALLOWED_REDIRECT_HOSTS") or DEFAULT_REDIRECT_HOST_SUFFIXES

    return Config(
        public_url=public_url,
        login_password=password,
        anthropic_api_key=_require("ANTHROPIC_API_KEY"),
        anthropic_model=os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5").strip() or "claude-sonnet-5",
        anthropic_max_tokens=_int("ANTHROPIC_MAX_TOKENS", 1024),
        language=os.environ.get("ALEXA_MCP_LANGUAGE", "pt-BR").strip() or "pt-BR",
        max_spoken_chars=_int("ALEXA_MCP_MAX_SPOKEN_CHARS", 600),
        history_turns=_int("ALEXA_MCP_HISTORY_TURNS", 12),
        db_path=os.environ.get("ALEXA_MCP_DB_PATH", "data/alexa_mcp.sqlite3").strip(),
        host=os.environ.get("ALEXA_MCP_HOST", "127.0.0.1").strip() or "127.0.0.1",
        port=_int("ALEXA_MCP_PORT", 8080),
        access_token_ttl=_int("ALEXA_MCP_ACCESS_TOKEN_TTL", 3600),
        refresh_token_ttl=_int("ALEXA_MCP_REFRESH_TOKEN_TTL", 60 * 60 * 24 * 30),
        allowed_redirect_host_suffixes=allowlist,
        static_client_id=os.environ.get("ALEXA_MCP_STATIC_CLIENT_ID", "").strip() or None,
        static_client_secret=os.environ.get("ALEXA_MCP_STATIC_CLIENT_SECRET", "").strip() or None,
        static_redirect_uris=_csv("ALEXA_MCP_STATIC_REDIRECT_URIS"),
    )
