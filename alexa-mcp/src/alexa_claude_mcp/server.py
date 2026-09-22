"""The MCP server Alexa+ talks to: three tools, all scoped to the authenticated owner."""

from __future__ import annotations

import datetime as dt
import logging

from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.settings import AuthSettings, ClientRegistrationOptions, RevocationOptions
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from pydantic import AnyHttpUrl, BaseModel, Field

from .claude import ClaudeBridge
from .config import Config
from .oauth import SUBJECT, AlexaOAuthProvider
from .storage import Store

logger = logging.getLogger(__name__)

INSTRUCTIONS = """Ponte entre o Alexa+ e o Claude.

Use `ask_claude` para qualquer pergunta aberta, raciocínio, redação ou explicação técnica
que o usuário fizer por voz. A resposta já volta curta e pronta para ser falada.
Para continuar o mesmo assunto, repita o `conversation_id` devolvido na chamada anterior;
sem ele, cada pergunta começa uma conversa nova.
Use `list_conversations` e `get_conversation` quando o usuário perguntar sobre o que já
conversou com o Claude.
"""


class AskResult(BaseModel):
    answer: str = Field(description="Resposta do Claude, já formatada para ser falada em voz alta.")
    conversation_id: str = Field(description="Passe este id em ask_claude para continuar o assunto.")
    truncated: bool = Field(description="True quando a resposta foi encurtada para caber na fala.")


class ConversationInfo(BaseModel):
    conversation_id: str
    title: str
    message_count: int
    updated_at: str


class ConversationList(BaseModel):
    conversations: list[ConversationInfo]


class ConversationTranscript(BaseModel):
    conversation_id: str
    title: str
    messages: list[dict[str, str]]


def _subject() -> str:
    """The resource owner behind the current request.

    Tokens carry the subject; a missing token only happens in tests or if auth is off.
    """
    token = get_access_token()
    if token is None:
        return SUBJECT
    return token.subject or SUBJECT


def _iso(timestamp: float) -> str:
    return dt.datetime.fromtimestamp(timestamp, tz=dt.UTC).isoformat(timespec="seconds")


def build_server(config: Config, store: Store, bridge: ClaudeBridge) -> MCPServer:
    provider = AlexaOAuthProvider(config, store)
    server = MCPServer(
        name="claude-for-alexa",
        title="Claude para Alexa+",
        version="0.1.0",
        instructions=INSTRUCTIONS,
        website_url="https://github.com/luisERH/alexa-mcp",
        auth_server_provider=provider,
        auth=AuthSettings(
            issuer_url=AnyHttpUrl(config.public_url),
            resource_server_url=AnyHttpUrl(config.mcp_url),
            validate_token_resource=False,  # tokens are minted here; audience is checked below
            required_scopes=list(config.scopes),
            client_registration_options=ClientRegistrationOptions(
                enabled=True,
                valid_scopes=list(config.scopes),
                default_scopes=list(config.scopes),
            ),
            revocation_options=RevocationOptions(enabled=True),
        ),
    )

    @server.tool(
        name="ask_claude",
        title="Perguntar ao Claude",
        description=(
            "Envia uma pergunta ao Claude e devolve a resposta pronta para ser falada. "
            "Use para perguntas abertas, explicações, resumos, ideias, código explicado em "
            "palavras e qualquer coisa que exija raciocínio. Para continuar o assunto "
            "anterior, passe o conversation_id devolvido antes."
        ),
    )
    async def ask_claude(question: str, conversation_id: str | None = None) -> AskResult:
        """Ask Claude a question.

        Args:
            question: A pergunta do usuário, em linguagem natural.
            conversation_id: Id devolvido por uma chamada anterior, para manter o contexto.
        """
        try:
            answer = await bridge.ask(
                subject=_subject(), question=question, conversation_id=conversation_id
            )
        except ValueError as exc:
            # Anticipated: an empty question or a conversation_id the orchestrator invented.
            raise ToolError(str(exc)) from exc
        return AskResult(
            answer=answer.text, conversation_id=answer.conversation_id, truncated=answer.truncated
        )

    @server.tool(
        name="list_conversations",
        title="Listar conversas com o Claude",
        description="Lista as conversas mais recentes com o Claude, da mais recente para a mais antiga.",
    )
    async def list_conversations(limit: int = 5) -> ConversationList:
        """List recent conversations.

        Args:
            limit: Quantas conversas devolver (1 a 20).
        """
        limit = max(1, min(limit, 20))
        summaries = store.list_conversations(_subject(), limit)
        return ConversationList(
            conversations=[
                ConversationInfo(
                    conversation_id=item.id,
                    title=item.title,
                    message_count=item.message_count,
                    updated_at=_iso(item.updated_at),
                )
                for item in summaries
            ]
        )

    @server.tool(
        name="get_conversation",
        title="Reler uma conversa",
        description="Devolve as últimas mensagens de uma conversa com o Claude.",
    )
    async def get_conversation(conversation_id: str, limit: int = 6) -> ConversationTranscript:
        """Read back a conversation.

        Args:
            conversation_id: Id da conversa.
            limit: Quantas mensagens recentes devolver (1 a 40).
        """
        subject = _subject()
        summary = store.get_conversation(conversation_id, subject)
        if summary is None:
            raise ToolError(f"conversa {conversation_id} não encontrada")
        limit = max(1, min(limit, 40))
        return ConversationTranscript(
            conversation_id=summary.id,
            title=summary.title,
            messages=store.recent_messages(conversation_id, limit),
        )

    _register_http_routes(server, config, provider)
    return server


def _register_http_routes(server: MCPServer, config: Config, provider: AlexaOAuthProvider) -> None:
    """Consent screen and health check, served next to /mcp."""
    from starlette.requests import Request
    from starlette.responses import HTMLResponse, JSONResponse, RedirectResponse

    from .templates import render_login

    @server.custom_route("/healthz", methods=["GET"])
    async def healthz(_request: Request) -> JSONResponse:
        return JSONResponse({"status": "ok", "resource": config.mcp_url})

    @server.custom_route("/login", methods=["GET"])
    async def login_form(request: Request) -> HTMLResponse:
        request_id = request.query_params.get("request_id", "")
        client_name = provider.pending_client_name(request_id)
        if not request_id or client_name is None:
            return HTMLResponse(
                render_login(request_id="", client_name="", error="Sessão de autorização expirada."),
                status_code=400,
            )
        return HTMLResponse(render_login(request_id=request_id, client_name=client_name, error=""))

    @server.custom_route("/login", methods=["POST"])
    async def login_submit(request: Request) -> HTMLResponse | RedirectResponse:
        form = await request.form()
        request_id = str(form.get("request_id", ""))
        if form.get("action") == "deny":
            denied = provider.denied_redirect(request_id)
            if denied:
                return RedirectResponse(denied, status_code=302)
            return HTMLResponse(
                render_login(request_id="", client_name="", error="Sessão de autorização expirada."),
                status_code=400,
            )

        redirect, error = provider.complete_login(request_id, str(form.get("password", "")))
        if redirect is None:
            client_name = provider.pending_client_name(request_id) or ""
            status = 401 if client_name else 400
            return HTMLResponse(
                render_login(
                    request_id=request_id if client_name else "",
                    client_name=client_name,
                    error=error,
                ),
                status_code=status,
            )
        return RedirectResponse(redirect, status_code=302)
