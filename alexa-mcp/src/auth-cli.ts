#!/usr/bin/env node
/**
 * Login na Amazon pelo navegador.
 *
 * A API que a Alexa usa é privada: não há chave de API, o que existe é a sessão do app.
 * O alexa-remote2 sobe um proxy local, você entra na página real da Amazon (2FA inclusive)
 * e a sessão resultante fica salva no seu computador.
 */
import AlexaRemote from "alexa-remote2";

import { saveAuth } from "./auth-store.js";
import type { RemoteLike } from "./client.js";
import { loadConfig } from "./config.js";

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const remote = new AlexaRemote() as unknown as RemoteLike;
  const proxyUrl = `http://${config.proxyHost}:${config.proxyPort}`;

  log("");
  log("=== Login na sua conta Amazon ===");
  log(`1. Abra ${proxyUrl} no navegador deste computador.`);
  log("2. Entre com a sua conta Amazon (a mesma do app Alexa). O 2FA funciona normalmente.");
  log("3. Quando a página disser que terminou, volte aqui.");
  log("");
  log(`Marketplace: ${config.amazonPage} · idioma: ${config.acceptLanguage}`);
  log("Se a sua conta for de outro país, ajuste ALEXA_AMAZON_PAGE e ALEXA_SERVICE_HOST.");
  log("");

  let saved = false;
  remote.on("cookie", () => {
    if (!remote.cookieData) return;
    saveAuth(config.authFile, remote.cookieData as Record<string, unknown>);
    saved = true;
  });

  await new Promise<void>((resolve, reject) => {
    remote.init(
      {
        proxyOnly: true,
        proxyOwnIp: config.proxyHost,
        proxyPort: config.proxyPort,
        proxyLogLevel: "warn",
        amazonPage: config.amazonPage,
        alexaServiceHost: config.alexaServiceHost,
        acceptLanguage: config.acceptLanguage,
        cookieRefreshInterval: 0,
        usePushConnection: false,
        bluetooth: false,
      },
      (err?: Error) => (err ? reject(err) : resolve()),
    );
  });

  if (!saved && remote.cookieData) {
    saveAuth(config.authFile, remote.cookieData as Record<string, unknown>);
    saved = true;
  }
  if (!saved) {
    throw new Error("o login terminou sem devolver uma sessão utilizável.");
  }

  const devices = Object.values(remote.serialNumbers ?? {});
  log("");
  log(`Sessão salva em ${config.authFile} (somente leitura para o seu usuário).`);
  log(`Dispositivos encontrados: ${devices.map((d) => d.accountName).join(", ") || "nenhum"}`);
  log("");
  log("Agora aponte o Claude para este servidor:");
  log(`  claude mcp add alexa -- node ${process.cwd()}/dist/index.js`);
  log("");

  await new Promise<void>((resolve) => {
    if (typeof remote.stopProxyServer === "function") remote.stopProxyServer(() => resolve());
    else resolve();
  });
  process.exit(0);
}

main().catch((error: unknown) => {
  process.stderr.write(`\nFalha no login: ${(error as Error).message}\n`);
  process.exit(1);
});
