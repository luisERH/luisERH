"""ASGI application factory."""

from __future__ import annotations

import logging

from mcp.server.transport_security import TransportSecuritySettings
from starlette.applications import Starlette

from .claude import ClaudeBridge
from .config import Config, load_config
from .server import build_server
from .storage import Store

logger = logging.getLogger(__name__)


def create_app(config: Config | None = None, *, client=None) -> Starlette:
    """Build the Starlette app serving /mcp, the OAuth endpoints, /login and /healthz.

    Args:
        config: Overrides the environment-derived config (used by tests).
        client: Overrides the Anthropic client (used by tests).
    """
    config = config or load_config()
    store = Store(config.db_path)
    bridge = ClaudeBridge(config, store, client=client)
    server = build_server(config, store, bridge)

    app = server.streamable_http_app(
        streamable_http_path="/mcp",
        json_response=False,
        host=config.host,
        transport_security=TransportSecuritySettings(
            enable_dns_rebinding_protection=True,
            # The public hostname is what Alexa+ sends; localhost covers tunnels and probes.
            allowed_hosts=[config.public_host, "localhost", "127.0.0.1", f"{config.host}:{config.port}"],
            allowed_origins=[config.public_url, "http://localhost", "http://127.0.0.1"],
        ),
    )
    app.state.config = config
    app.state.store = store
    app.state.bridge = bridge
    logger.info("MCP endpoint: %s", config.mcp_url)
    return app
