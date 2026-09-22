import { homedir } from "node:os";
import { join } from "node:path";

/** Onde a sessão da Amazon fica guardada e como falar com a API da Alexa. */
export interface Config {
  /** Arquivo com os dados de login (cookie + registro do dispositivo). */
  authFile: string;
  /** Página de login da Amazon da sua conta, p.ex. amazon.com.br */
  amazonPage: string;
  /** Host do serviço Alexa da sua região. */
  alexaServiceHost: string;
  /** Accept-Language usado no login e nas chamadas. */
  acceptLanguage: string;
  /** IP/host usado para abrir o proxy de login — precisa bater com a URL que você abre no navegador. */
  proxyHost: string;
  proxyPort: number;
  /** Intervalo de renovação do cookie, em ms. 0 desliga. */
  cookieRefreshInterval: number;
  /** Timeout de cada chamada à Amazon, em ms. */
  requestTimeoutMs: number;
  /** Dispositivo usado quando a ferramenta não recebe um. */
  defaultDevice?: string;
}

function num(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`valor numérico inválido: ${value}`);
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    authFile: env.ALEXA_MCP_AUTH_FILE ?? join(homedir(), ".alexa-mcp", "auth.json"),
    // Padrões pensados para uma conta brasileira; ajuste pelas variáveis de ambiente
    // se a sua conta Amazon for de outro país.
    amazonPage: env.ALEXA_AMAZON_PAGE ?? "amazon.com.br",
    alexaServiceHost: env.ALEXA_SERVICE_HOST ?? "pitangui.amazon.com",
    acceptLanguage: env.ALEXA_ACCEPT_LANGUAGE ?? "pt-BR",
    proxyHost: env.ALEXA_PROXY_HOST ?? "127.0.0.1",
    proxyPort: num(env.ALEXA_PROXY_PORT, 3456),
    cookieRefreshInterval: num(env.ALEXA_COOKIE_REFRESH_INTERVAL, 4 * 24 * 60 * 60 * 1000),
    requestTimeoutMs: num(env.ALEXA_REQUEST_TIMEOUT_MS, 30_000),
    defaultDevice: env.ALEXA_DEFAULT_DEVICE || undefined,
  };
}
