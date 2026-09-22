from __future__ import annotations

import base64
import hashlib
import json
import secrets
import socket
import threading
import time
from dataclasses import dataclass
from typing import Any

import httpx
import pytest
import uvicorn

from alexa_claude_mcp.app import create_app
from alexa_claude_mcp.config import Config

PASSWORD = "senha-de-teste-123"
REDIRECT_URI = "http://localhost:3000/callback"


@dataclass
class _TextBlock:
    text: str
    type: str = "text"


@dataclass
class _Response:
    content: list[_TextBlock]
    stop_reason: str = "end_turn"


class FakeMessages:
    """Stands in for `anthropic.AsyncAnthropic().messages`."""

    def __init__(self, reply: str) -> None:
        self.reply = reply
        self.calls: list[dict[str, Any]] = []

    async def create(self, **kwargs: Any) -> _Response:
        self.calls.append(kwargs)
        return _Response(content=[_TextBlock(text=self.reply)])


class FakeAnthropic:
    def __init__(self, reply: str = "A resposta curta do Claude.") -> None:
        self.messages = FakeMessages(reply)


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@pytest.fixture
def config(tmp_path) -> Config:
    port = _free_port()
    return Config(
        public_url=f"http://localhost:{port}",
        login_password=PASSWORD,
        anthropic_api_key="sk-test",
        db_path=str(tmp_path / "test.sqlite3"),
        host="127.0.0.1",
        port=port,
        allowed_redirect_host_suffixes=("localhost", "127.0.0.1"),
    )


@pytest.fixture
def fake_anthropic() -> FakeAnthropic:
    return FakeAnthropic()


@pytest.fixture
def live_server(config, fake_anthropic):
    """Serve the real app with uvicorn on a loopback port.

    A real server (rather than an in-process ASGI transport) keeps the MCP session
    manager's lifespan in its own event loop, and exercises the Host/Origin checks the
    way Alexa+ will hit them.
    """
    app = create_app(config, client=fake_anthropic)
    server = uvicorn.Server(
        uvicorn.Config(app, host=config.host, port=config.port, log_level="warning")
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 15
    while not server.started:
        if time.monotonic() > deadline:  # pragma: no cover - only on a broken environment
            raise RuntimeError("uvicorn did not start in time")
        if not thread.is_alive():  # pragma: no cover
            raise RuntimeError("uvicorn thread died during startup")
        time.sleep(0.02)
    try:
        yield config.public_url
    finally:
        server.should_exit = True
        thread.join(timeout=15)


@pytest.fixture
async def client(live_server):
    """An httpx client pointed at the live server."""
    async with httpx.AsyncClient(base_url=live_server, follow_redirects=False) as http:
        yield http


def pkce_pair() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(verifier.encode()).digest()
    challenge = base64.urlsafe_b64encode(digest).decode().rstrip("=")
    return verifier, challenge


async def register_client(http: httpx.AsyncClient, redirect_uri: str = REDIRECT_URI) -> dict[str, Any]:
    response = await http.post(
        "/register",
        json={
            "client_name": "Alexa+ (teste)",
            "redirect_uris": [redirect_uri],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
            "scope": "claude:ask",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


async def obtain_token(http: httpx.AsyncClient, *, password: str = PASSWORD) -> dict[str, Any]:
    """Run the whole authorization code + PKCE flow and return the token response."""
    client_info = await register_client(http)
    verifier, challenge = pkce_pair()

    authorize = await http.get(
        "/authorize",
        params={
            "response_type": "code",
            "client_id": client_info["client_id"],
            "redirect_uri": REDIRECT_URI,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": "estado-123",
            "scope": "claude:ask",
            "resource": f"{http.base_url}/mcp",
        },
    )
    assert authorize.status_code == 302, authorize.text
    login_url = authorize.headers["location"]
    request_id = httpx.URL(login_url).params["request_id"]

    submit = await http.post(
        "/login", data={"request_id": request_id, "password": password, "action": "allow"}
    )
    assert submit.status_code == 302, submit.text
    callback = httpx.URL(submit.headers["location"])
    code = callback.params["code"]
    assert callback.params["state"] == "estado-123"

    token = await http.post(
        "/token",
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": REDIRECT_URI,
            "client_id": client_info["client_id"],
            "code_verifier": verifier,
            "resource": f"{http.base_url}/mcp",
        },
    )
    assert token.status_code == 200, token.text
    payload = token.json()
    payload["client_id"] = client_info["client_id"]
    return payload


def parse_sse(body: str) -> list[dict[str, Any]]:
    """Pull the JSON payloads out of a text/event-stream response."""
    messages = []
    for line in body.splitlines():
        if line.startswith("data:"):
            messages.append(json.loads(line[len("data:"):].strip()))
    return messages


class McpSession:
    """Minimal Streamable HTTP client: initialize once, then send requests."""

    def __init__(self, http: httpx.AsyncClient, access_token: str) -> None:
        self._http = http
        self._token = access_token
        self._session_id: str | None = None
        self._next_id = 0
        self.protocol_version = "2025-11-25"

    def _headers(self) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self._token}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        if self._session_id:
            headers["mcp-session-id"] = self._session_id
            headers["MCP-Protocol-Version"] = self.protocol_version
        return headers

    async def _post(self, payload: dict[str, Any]) -> httpx.Response:
        return await self._http.post("/mcp", content=json.dumps(payload), headers=self._headers())

    async def initialize(self) -> dict[str, Any]:
        self._next_id += 1
        response = await self._post(
            {
                "jsonrpc": "2.0",
                "id": self._next_id,
                "method": "initialize",
                "params": {
                    "protocolVersion": self.protocol_version,
                    "capabilities": {},
                    "clientInfo": {"name": "alexa-plus-test", "version": "1.0"},
                },
            }
        )
        assert response.status_code == 200, response.text
        self._session_id = response.headers.get("mcp-session-id")
        result = parse_sse(response.text)[0]["result"]
        notify = await self._http.post(
            "/mcp",
            content=json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            headers=self._headers(),
        )
        assert notify.status_code in (200, 202), notify.text
        return result

    async def request(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        self._next_id += 1
        response = await self._post(
            {"jsonrpc": "2.0", "id": self._next_id, "method": method, "params": params or {}}
        )
        assert response.status_code == 200, response.text
        return parse_sse(response.text)[0]


@pytest.fixture
async def session(client) -> McpSession:
    token = await obtain_token(client)
    mcp = McpSession(client, token["access_token"])
    await mcp.initialize()
    return mcp
