"""Entry point: `python -m alexa_claude_mcp` or the `alexa-claude-mcp` script."""

from __future__ import annotations

import logging
import sys

from .config import ConfigError, load_config


def main() -> int:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)-8s %(name)s: %(message)s"
    )
    try:
        from dotenv import load_dotenv

        load_dotenv()
    except ImportError:  # pragma: no cover - dotenv is a convenience, not a requirement
        pass

    try:
        config = load_config()
    except ConfigError as exc:
        print(f"erro de configuração: {exc}", file=sys.stderr)
        print("copie .env.example para .env e preencha os valores.", file=sys.stderr)
        return 2

    import uvicorn

    from .app import create_app

    uvicorn.run(create_app(config), host=config.host, port=config.port, log_level="info")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
