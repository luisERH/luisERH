"""Claude as an Alexa+ MCP add-on."""

from .app import create_app
from .config import Config, load_config

__all__ = ["Config", "create_app", "load_config"]
__version__ = "0.1.0"
