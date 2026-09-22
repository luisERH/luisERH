import httpx
import pytest

from .conftest import PASSWORD, REDIRECT_URI, obtain_token, pkce_pair, register_client


async def test_protected_resource_metadata_points_at_this_server(client):
    response = await client.get("/.well-known/oauth-protected-resource/mcp")
    assert response.status_code == 200
    body = response.json()
    assert body["resource"] == f"{client.base_url}/mcp"
    assert str(client.base_url) in body["authorization_servers"][0]


async def test_authorization_server_metadata_advertises_pkce_and_registration(client):
    response = await client.get("/.well-known/oauth-authorization-server")
    assert response.status_code == 200
    body = response.json()
    assert "S256" in body["code_challenge_methods_supported"]
    assert body["registration_endpoint"] == f"{client.base_url}/register"
    assert "authorization_code" in body["grant_types_supported"]
    assert "refresh_token" in body["grant_types_supported"]


async def test_unauthenticated_mcp_call_is_challenged(client):
    response = await client.post(
        "/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
        headers={"Accept": "application/json, text/event-stream"},
    )
    assert response.status_code == 401
    assert "resource_metadata" in response.headers.get("www-authenticate", "")


async def test_full_authorization_code_flow_issues_a_token(client):
    token = await obtain_token(client)
    assert token["token_type"] == "Bearer"
    assert token["access_token"]
    assert token["refresh_token"]
    assert token["expires_in"] == 3600


async def test_wrong_password_does_not_issue_a_code(client):
    client_info = await register_client(client)
    _, challenge = pkce_pair()
    authorize = await client.get(
        "/authorize",
        params={
            "response_type": "code",
            "client_id": client_info["client_id"],
            "redirect_uri": REDIRECT_URI,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "scope": "claude:ask",
        },
    )
    request_id = httpx.URL(authorize.headers["location"]).params["request_id"]
    response = await client.post(
        "/login", data={"request_id": request_id, "password": "errada", "action": "allow"}
    )
    assert response.status_code == 401
    assert "Senha incorreta" in response.text


async def test_wrong_code_verifier_is_rejected(client):
    client_info = await register_client(client)
    _, challenge = pkce_pair()
    authorize = await client.get(
        "/authorize",
        params={
            "response_type": "code",
            "client_id": client_info["client_id"],
            "redirect_uri": REDIRECT_URI,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "scope": "claude:ask",
        },
    )
    request_id = httpx.URL(authorize.headers["location"]).params["request_id"]
    submit = await client.post(
        "/login", data={"request_id": request_id, "password": PASSWORD, "action": "allow"}
    )
    code = httpx.URL(submit.headers["location"]).params["code"]

    other_verifier, _ = pkce_pair()
    token = await client.post(
        "/token",
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": REDIRECT_URI,
            "client_id": client_info["client_id"],
            "code_verifier": other_verifier,
        },
    )
    assert token.status_code == 400
    assert token.json()["error"] == "invalid_grant"


async def test_authorization_code_is_single_use(client):
    client_info = await register_client(client)
    verifier, challenge = pkce_pair()
    authorize = await client.get(
        "/authorize",
        params={
            "response_type": "code",
            "client_id": client_info["client_id"],
            "redirect_uri": REDIRECT_URI,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "scope": "claude:ask",
        },
    )
    request_id = httpx.URL(authorize.headers["location"]).params["request_id"]
    submit = await client.post(
        "/login", data={"request_id": request_id, "password": PASSWORD, "action": "allow"}
    )
    code = httpx.URL(submit.headers["location"]).params["code"]
    form = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": REDIRECT_URI,
        "client_id": client_info["client_id"],
        "code_verifier": verifier,
    }
    first = await client.post("/token", data=form)
    assert first.status_code == 200
    second = await client.post("/token", data=form)
    assert second.status_code == 400


async def test_refresh_token_rotates(client):
    token = await obtain_token(client)
    refreshed = await client.post(
        "/token",
        data={
            "grant_type": "refresh_token",
            "refresh_token": token["refresh_token"],
            "client_id": token["client_id"],
        },
    )
    assert refreshed.status_code == 200
    new_token = refreshed.json()
    assert new_token["refresh_token"] != token["refresh_token"]

    reused = await client.post(
        "/token",
        data={
            "grant_type": "refresh_token",
            "refresh_token": token["refresh_token"],
            "client_id": token["client_id"],
        },
    )
    assert reused.status_code == 400


async def test_registration_rejects_a_redirect_host_off_the_allowlist(client):
    response = await client.post(
        "/register",
        json={
            "client_name": "Cliente suspeito",
            "redirect_uris": ["https://atacante.example.com/callback"],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
        },
    )
    assert response.status_code == 400
    assert response.json()["error"] == "invalid_redirect_uri"


async def test_cancel_returns_access_denied(client):
    client_info = await register_client(client)
    _, challenge = pkce_pair()
    authorize = await client.get(
        "/authorize",
        params={
            "response_type": "code",
            "client_id": client_info["client_id"],
            "redirect_uri": REDIRECT_URI,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "scope": "claude:ask",
        },
    )
    request_id = httpx.URL(authorize.headers["location"]).params["request_id"]
    response = await client.post("/login", data={"request_id": request_id, "action": "deny"})
    assert response.status_code == 302
    assert httpx.URL(response.headers["location"]).params["error"] == "access_denied"


async def test_healthz(client):
    response = await client.get("/healthz")
    assert response.status_code == 200
    assert response.json()["resource"] == f"{client.base_url}/mcp"


@pytest.mark.parametrize("redirect", ["https://alexa.amazon.com/cb", "http://localhost:3000/cb"])
def test_config_allows_expected_redirect_hosts(config, redirect):
    allowed = config.__class__(
        public_url=config.public_url,
        login_password=config.login_password,
        anthropic_api_key=config.anthropic_api_key,
    )
    assert allowed.redirect_uri_allowed(redirect)


def test_config_rejects_plain_http_on_a_public_host(config):
    assert not config.redirect_uri_allowed("http://alexa.amazon.com/cb")
