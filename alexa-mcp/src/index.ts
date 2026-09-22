#!/usr/bin/env node
/** Servidor MCP: dá ao Claude o controle da sua conta Alexa, por stdio. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { AlexaClient } from "./client.js";
import { loadConfig } from "./config.js";
import { hasAuth } from "./auth-store.js";
import { registerAllTools } from "./tools/index.js";

const INSTRUCTIONS = `Controle da conta Alexa do usuário.

Comece por list_devices para saber os nomes exatos dos Echos — as outras ferramentas
aceitam o nome como aparece no app Alexa.

send_voice_command é o curinga: manda uma frase para a Alexa como se tivesse sido falada,
então resolve qualquer coisa que as ferramentas específicas não cobrem.

Para casa inteligente, list_smarthome_devices mostra o entityId e as ações que cada
aparelho aceita antes de acionar qualquer coisa.`;

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new AlexaClient(config);

  const server = new McpServer(
    { name: "alexa-mcp", version: "0.1.0" },
    { instructions: INSTRUCTIONS },
  );
  registerAllTools(server, client);

  if (!hasAuth(config.authFile)) {
    // stderr não atrapalha o protocolo (que vive no stdout) e aparece no log do cliente MCP.
    process.stderr.write(
      `[alexa-mcp] nenhuma sessão em ${config.authFile}. Rode "npm run auth" para entrar na conta Amazon.\n`,
    );
  }

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(`[alexa-mcp] falha ao iniciar: ${(error as Error).message}\n`);
  process.exit(1);
});
