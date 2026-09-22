# alexa-mcp

Servidor MCP que dá ao **Claude o controle da sua Alexa**: falar nos Echos, mandar comandos de
voz, rodar rotinas, acender luz, mexer nas listas e criar lembretes — tudo por conversa, sem
chave de API.

```
  você  ──▶  Claude (Desktop / Code)  ──MCP/stdio──▶  alexa-mcp  ──▶  conta Amazon  ──▶  seus Echos
```

## O que dá para pedir

| Ferramenta | Para quê |
|---|---|
| `list_devices` | Echos da conta, com volume, online e "não perturbe" |
| `speak` | Falar um texto no Echo (anúncio, fala direta ou SSML) |
| `send_voice_command` | Mandar qualquer frase como se você tivesse falado ("toque jazz na sala") |
| `set_volume`, `control_playback` | Volume e play/pause/próxima/anterior |
| `set_do_not_disturb` | Não perturbe, num aparelho ou em todos |
| `rename_device` | Renomear um Echo |
| `list_routines`, `run_routine` | Ver e executar as rotinas que você já criou |
| `list_smarthome_devices`, `list_smarthome_groups` | Aparelhos e cômodos da casa inteligente |
| `get_smarthome_state`, `control_smarthome_device` | Estado e acionamento (liga, desliga, brilho, cor, temperatura) |
| `get_lists`, `get_list_items`, `add_list_item` | Listas de compras e tarefas |
| `list_notifications`, `create_reminder`, `cancel_notification` | Alarmes, timers e lembretes |

Nomes com acento e caixa diferente funcionam: "sala de estar" acha o "Sala de Estar". Quando o
nome casa com mais de um aparelho, a ferramenta devolve as opções em vez de chutar.

## Instalação

```bash
git clone https://github.com/luisERH/alexa-mcp.git
cd alexa-mcp
npm install
npm run build
```

Precisa de Node 20+.

### 1. Entrar na sua conta Amazon

A API que o app Alexa usa é **privada**: não existe chave de API, o que existe é a sessão do
aplicativo. O login é feito uma vez, no seu navegador, por um proxy local:

```bash
npm run auth
```

Abra `http://127.0.0.1:3456`, entre com a sua conta Amazon (2FA funciona — é a página real da
Amazon) e pronto. A sessão fica em `~/.alexa-mcp/auth.json`, com permissão `0600`, e é renovada
sozinha enquanto o servidor roda.

> Abra o proxy num computador **sem o app Alexa instalado** no mesmo dispositivo, e use exatamente
> a URL acima — se o endereço não bater com `ALEXA_PROXY_HOST`, a Amazon mostra a página de QR
> code em vez do login.

### 2. Ligar ao Claude

Claude Code:

```bash
claude mcp add alexa -- node /caminho/completo/para/alexa-mcp/dist/index.js
```

Claude Desktop — em `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "alexa": {
      "command": "node",
      "args": ["/caminho/completo/para/alexa-mcp/dist/index.js"],
      "env": { "ALEXA_DEFAULT_DEVICE": "Sala de Estar" }
    }
  }
}
```

Depois é só conversar: *"quais Echos eu tenho?"*, *"anuncia na sala que o jantar tá pronto"*,
*"roda a rotina de boa noite"*, *"põe café na lista de compras"*.

## Configuração

Tudo por variável de ambiente; os padrões são para uma conta brasileira.

| Variável | Padrão | Para quê |
|---|---|---|
| `ALEXA_MCP_AUTH_FILE` | `~/.alexa-mcp/auth.json` | Onde a sessão fica salva |
| `ALEXA_AMAZON_PAGE` | `amazon.com.br` | Marketplace da sua conta |
| `ALEXA_SERVICE_HOST` | `pitangui.amazon.com` | Host do serviço Alexa da região |
| `ALEXA_ACCEPT_LANGUAGE` | `pt-BR` | Idioma do login e das chamadas |
| `ALEXA_DEFAULT_DEVICE` | — | Echo usado quando você não diz qual |
| `ALEXA_PROXY_HOST` / `ALEXA_PROXY_PORT` | `127.0.0.1` / `3456` | Proxy do login |
| `ALEXA_REQUEST_TIMEOUT_MS` | `30000` | Timeout de cada chamada |
| `ALEXA_COOKIE_REFRESH_INTERVAL` | `345600000` (4 dias) | Renovação da sessão; `0` desliga |

Conta de outro país? Os pares mais comuns são `amazon.com` + `pitangui.amazon.com`,
`amazon.com.br` + `pitangui.amazon.com`, `amazon.de` (e demais da Europa) + `layla.amazon.de`,
`amazon.co.jp` + `alexa.amazon.co.jp`.

## Segurança

- `~/.alexa-mcp/auth.json` **vale o mesmo que a sua senha da Amazon**: é gravado só para o seu
  usuário (`0600`, diretório `0700`) e nunca deve ir para o git nem para backup em nuvem sem
  criptografia.
- O servidor fala por stdio com o Claude no seu computador — nada é exposto na rede.
- Nenhuma ferramenta apaga dispositivo, grupo ou conta. O que existe é controle e configuração.
- Para revogar o acesso: apague o arquivo de sessão e saia dos dispositivos conectados em
  *Amazon → Sua conta → Dispositivos registrados*.

## Como isto funciona (e o que pode quebrar)

Por baixo está o [alexa-remote2](https://github.com/Apollon77/alexa-remote), que conversa com a
mesma API privada que o app Alexa usa. Isso tem consequências que vale saber:

- **Não é uma API oficial.** A Amazon pode mudar qualquer endpoint sem aviso; quando isso
  acontece, a correção vem de uma atualização do `alexa-remote2`.
- **A sessão expira.** Normalmente ela se renova sozinha; quando não der, rode `npm run auth` de novo.
- **Criar rotinas não dá.** A API expõe listar e executar rotinas; a criação continua no app
  Alexa. Para o resto, `send_voice_command` costuma resolver — é literalmente falar com a Alexa.
- Um add-on oficial existe pelo [Alexa+ MCP Toolkit](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-overview.html),
  mas ele é o caminho inverso (a Alexa chamando um servidor seu) e está disponível nos EUA.

## Desenvolvimento

```bash
npm test        # 52 testes, com um duplo do alexa-remote2 — nada de rede
npm run typecheck
npm run build
```

Os testes cobrem a resolução de nomes (acento, caixa, ambiguidade), o tratamento de erro de cada
ferramenta e os argumentos exatos passados para a API da Amazon.

## Licença

MIT
