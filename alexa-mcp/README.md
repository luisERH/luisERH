# Claude para Alexa+ (add-on MCP)

Servidor MCP que coloca o **Claude dentro da sua Alexa**. Ele fala o protocolo esperado pelo
[Alexa+ MCP Toolkit](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-overview.html):
**Streamable HTTP**, **OAuth 2.1 (authorization code + PKCE S256)** e descoberta via
*OAuth Protected Resource Metadata*. O Alexa+ é o **cliente** MCP; este repositório é o **servidor**.

```
  "Alexa, pergunta pro Claude ..."
            │
            ▼
   ┌──────────────────┐   OAuth 2.1 + PKCE    ┌─────────────────────────┐   Messages API   ┌────────┐
   │  Alexa+ (client) │ ────────────────────▶ │ este servidor (/mcp)    │ ───────────────▶ │ Claude │
   │  orquestrador    │ ◀──────────────────── │ ask_claude, conversas   │ ◀─────────────── │        │
   └──────────────────┘   Streamable HTTP     └─────────────────────────┘                  └────────┘
```

## Ferramentas expostas

| Ferramenta | O que faz |
|---|---|
| `ask_claude(question, conversation_id?)` | Manda a pergunta ao Claude e devolve a resposta **já formatada para fala**: sem markdown, sem URLs, sem blocos de código, cortada numa fronteira de frase. Devolve um `conversation_id`. |
| `list_conversations(limit)` | Lista as conversas recentes ("o que eu perguntei pro Claude hoje?"). |
| `get_conversation(conversation_id, limit)` | Relê as últimas mensagens de uma conversa. |

O contexto é mantido em SQLite: passar o `conversation_id` de volta em `ask_claude` continua o
assunto; sem ele, começa uma conversa nova.

## Requisitos

- Python 3.11+
- Uma **chave da API da Anthropic** (`ANTHROPIC_API_KEY`) — [console.anthropic.com](https://console.anthropic.com)
- Conta de desenvolvedor Amazon com acesso ao **Alexa+ for Builders**
- Uma URL pública HTTPS para o servidor (em desenvolvimento, um túnel como `cloudflared` resolve)

> **Disponibilidade:** o MCP Toolkit do Alexa+ está disponível **nos Estados Unidos**. Fora dos EUA
> o servidor roda e pode ser testado normalmente (MCP Inspector, Claude Code, Claude Desktop), mas a
> publicação do add-on depende da liberação do Alexa+ na sua região.

## Início rápido

```bash
git clone https://github.com/luisERH/alexa-mcp.git
cd alexa-mcp
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"

cp .env.example .env
# edite .env: ANTHROPIC_API_KEY, ALEXA_MCP_LOGIN_PASSWORD e ALEXA_MCP_PUBLIC_URL
python -m alexa_claude_mcp
```

Em outro terminal, exponha o servidor:

```bash
cloudflared tunnel --url http://127.0.0.1:8080
# copie a URL https://....trycloudflare.com para ALEXA_MCP_PUBLIC_URL no .env e reinicie
```

`ALEXA_MCP_PUBLIC_URL` precisa ser exatamente a URL pública: ela vira o *issuer* OAuth, o
identificador do recurso e a base do redirecionamento de login. Se ela estiver errada, o Alexa+
conclui o login e depois recusa o token.

Verifique:

```bash
curl -s https://SEU-DOMINIO/healthz
curl -s https://SEU-DOMINIO/.well-known/oauth-protected-resource/mcp
```

## Conectando ao Alexa+

1. Deixe o servidor rodando atrás da URL pública HTTPS.
2. No [Alexa+ for Builders](https://developer.amazon.com/alexaplus/), crie um add-on MCP e informe
   a URL do endpoint: `https://SEU-DOMINIO/mcp`.
3. O onboarding é feito pela **Alexa AI CLI** — siga o
   [QuickStart oficial](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-quickstart.html),
   que é a fonte de verdade para os comandos e para o formato do manifesto.
4. Quando o Alexa+ abrir a tela de autorização, digite a senha de `ALEXA_MCP_LOGIN_PASSWORD`.
   É esse passo que liga a sua conta Alexa a este servidor.
5. Teste na Alexa: *"Alexa, pergunta pro Claude o que é um vetor de embeddings."*

O servidor implementa **Dynamic Client Registration** (RFC 7591), então o Alexa+ se registra
sozinho. Se o console pedir `client_id`/`client_secret` fixos, preencha
`ALEXA_MCP_STATIC_CLIENT_ID`, `ALEXA_MCP_STATIC_CLIENT_SECRET` e `ALEXA_MCP_STATIC_REDIRECT_URIS`.

### Testando antes de publicar

Qualquer cliente MCP com suporte a OAuth serve para validar o servidor sem depender da
certificação da Amazon:

```bash
npx @modelcontextprotocol/inspector
# transporte: Streamable HTTP · URL: https://SEU-DOMINIO/mcp
```

Também dá para adicionar como conector remoto no Claude (Desktop ou Code) apontando para a mesma URL.

## Endpoints

| Rota | Função |
|---|---|
| `POST/GET/DELETE /mcp` | Endpoint MCP (Streamable HTTP), protegido por Bearer token |
| `/.well-known/oauth-protected-resource/mcp` | RFC 9728 — diz quem emite os tokens |
| `/.well-known/oauth-authorization-server` | RFC 8414 — metadados do servidor de autorização |
| `/register` | RFC 7591 — registro dinâmico de cliente |
| `/authorize`, `/token`, `/revoke` | Fluxo OAuth 2.1 (authorization code + PKCE S256) |
| `/login` | Tela de consentimento (senha do add-on) |
| `/healthz` | Health check |

## Configuração

| Variável | Obrigatória | Padrão | Descrição |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | sim | — | Chave da API da Anthropic |
| `ALEXA_MCP_PUBLIC_URL` | sim | — | URL pública HTTPS do servidor (sem barra final) |
| `ALEXA_MCP_LOGIN_PASSWORD` | sim | — | Senha da tela de consentimento (mín. 12 caracteres) |
| `ANTHROPIC_MODEL` | não | `claude-sonnet-5` | Modelo usado nas respostas |
| `ANTHROPIC_MAX_TOKENS` | não | `1024` | Teto de tokens por resposta |
| `ALEXA_MCP_LANGUAGE` | não | `pt-BR` | Idioma padrão das respostas |
| `ALEXA_MCP_MAX_SPOKEN_CHARS` | não | `600` | Tamanho máximo da resposta falada |
| `ALEXA_MCP_HISTORY_TURNS` | não | `12` | Mensagens de histórico enviadas ao Claude |
| `ALEXA_MCP_DB_PATH` | não | `data/alexa_mcp.sqlite3` | Banco SQLite |
| `ALEXA_MCP_HOST` / `ALEXA_MCP_PORT` | não | `127.0.0.1` / `8080` | Bind local |
| `ALEXA_MCP_ACCESS_TOKEN_TTL` | não | `3600` | Validade do access token (s) |
| `ALEXA_MCP_REFRESH_TOKEN_TTL` | não | `2592000` | Validade do refresh token (s) |
| `ALEXA_MCP_ALLOWED_REDIRECT_HOSTS` | não | domínios Amazon + localhost | Hosts aceitos em `redirect_uri` |
| `ALEXA_MCP_STATIC_CLIENT_ID` / `_SECRET` / `_REDIRECT_URIS` | não | — | Cliente OAuth fixo, quando não há registro dinâmico |

## Segurança

- **PKCE S256 obrigatório**; código de autorização de uso único, com validade de 5 minutos.
- **Refresh token rotativo**: o token apresentado é invalidado a cada troca.
- **Tokens guardados como hash SHA-256** — o arquivo do banco não contém credencial utilizável.
- **Allowlist de `redirect_uri`**: o registro dinâmico é aberto, então o host do redirecionamento é
  a barreira contra um cliente hostil se registrar e desviar o código. Só `https` (exceto localhost).
- **Proteção contra DNS rebinding** nos headers `Host`/`Origin` do endpoint MCP.
- **Limite de tentativas** na tela de login e comparação de senha em tempo constante.
- Rode sempre atrás de HTTPS. A senha do add-on é a única coisa entre a internet e a sua chave da
  Anthropic: use uma senha longa e única.

## Desenvolvimento

```bash
pytest          # suíte completa: fluxo OAuth ponta a ponta + chamadas MCP reais
ruff check .
```

Os testes sobem o app ASGI de verdade, executam o fluxo `register → authorize → login → token`,
abrem uma sessão MCP com o Bearer token e chamam as ferramentas. A API da Anthropic é substituída
por um cliente falso, então nada de rede e nenhum custo.

### Docker

```bash
docker build -t alexa-claude-mcp .
docker run --rm -p 8080:8080 --env-file .env -v "$PWD/data:/app/data" alexa-claude-mcp
```

Para produção, qualquer host que sirva ASGI com HTTPS funciona (ECS/Fargate, Cloud Run, Fly.io,
uma VM com nginx). Em Lambda, use um adaptador ASGI e troque o SQLite por armazenamento durável —
o *streaming* do MCP pede conexão longa, então Fargate/Cloud Run é o caminho mais direto.

## Limitações conhecidas

- O SQLite fica no disco local: em vários contêineres, use volume compartilhado ou troque a camada
  de `storage.py` por Postgres/DynamoDB.
- Um único dono (uma senha). Multiusuário exigiria um IdP de verdade (Cognito, Auth0) no lugar da
  tela de senha.
- Sem conteúdo visual: as respostas são só de voz. Telas exigiriam o padrão **MCP Apps**.

## Licença

MIT
