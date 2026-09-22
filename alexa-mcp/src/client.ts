import AlexaRemote from "alexa-remote2";

import { loadAuth, saveAuth } from "./auth-store.js";
import type { Config } from "./config.js";
import { AlexaApiError, AlexaAuthError, DeviceNotFoundError } from "./errors.js";

/** Um Echo (ou app) registrado na conta. */
export interface AlexaDevice {
  accountName: string;
  serialNumber: string;
  deviceType: string;
  deviceFamily?: string;
  deviceTypeFriendlyName?: string;
  online?: boolean;
  capabilities?: string[];
}

/**
 * A parte do alexa-remote2 que este servidor usa. Tipar estruturalmente (em vez de
 * depender da classe) deixa os testes injetarem um duplo sem subir nada de rede.
 */
export interface RemoteLike {
  serialNumbers: Record<string, AlexaDevice>;
  cookieData?: unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  init(options: unknown, callback: (err?: Error) => void): void;
  stopProxyServer?(callback: (err?: Error) => void): void;
  // As chamadas da API são resolvidas por nome em `call`.
  [method: string]: unknown;
}

/** Tira acentos e caixa: "Sala de Estar" e "sala de estar" viram a mesma coisa. */
export function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Acha o dispositivo pelo número de série ou pelo nome.
 *
 * Um nome parcial só vale quando casa com um dispositivo só — na dúvida, o erro lista as
 * opções, que é mais útil para o modelo do que escolher errado.
 */
export function matchDevice(devices: AlexaDevice[], query: string): AlexaDevice {
  const bySerial = devices.find((device) => device.serialNumber === query);
  if (bySerial) return bySerial;

  const wanted = normalize(query);
  const exact = devices.filter((device) => normalize(device.accountName) === wanted);
  if (exact.length === 1) return exact[0]!;

  const partial = devices.filter((device) => normalize(device.accountName).includes(wanted));
  if (partial.length === 1) return partial[0]!;

  const names = devices.map((device) => device.accountName).sort();
  if (partial.length > 1 || exact.length > 1) {
    const options = (exact.length > 1 ? exact : partial).map((d) => d.accountName).sort();
    throw new DeviceNotFoundError(
      `"${query}" casa com mais de um dispositivo: ${options.join(", ")}. Seja mais específico.`,
    );
  }
  throw new DeviceNotFoundError(
    `dispositivo "${query}" não encontrado. Disponíveis: ${names.join(", ") || "nenhum"}.`,
  );
}

/** Conexão preguiçosa com a conta Alexa, com as chamadas em forma de Promise. */
export class AlexaClient {
  private remote: RemoteLike | null = null;
  private connecting: Promise<RemoteLike> | null = null;

  constructor(
    private readonly config: Config,
    private readonly createRemote: () => RemoteLike = () => new AlexaRemote() as unknown as RemoteLike,
  ) {}

  /** Conecta na primeira chamada e reaproveita a sessão depois. */
  async ready(): Promise<RemoteLike> {
    if (this.remote) return this.remote;
    this.connecting ??= this.connect();
    try {
      this.remote = await this.connecting;
      return this.remote;
    } catch (error) {
      this.connecting = null; // deixa a próxima chamada tentar de novo
      throw error;
    }
  }

  private async connect(): Promise<RemoteLike> {
    const stored = loadAuth(this.config.authFile);
    if (!stored) {
      throw new AlexaAuthError(
        `nenhuma sessão da Amazon em ${this.config.authFile}. Rode "npm run auth" no terminal ` +
          "para entrar na sua conta pelo navegador.",
      );
    }

    const remote = this.createRemote();
    // O alexa-remote2 renova o cookie sozinho; persistir a renovação evita ter que
    // refazer o login por fora.
    remote.on("cookie", () => {
      if (remote.cookieData) saveAuth(this.config.authFile, remote.cookieData as Record<string, unknown>);
    });

    await new Promise<void>((resolve, reject) => {
      remote.init(
        {
          cookie: stored,
          proxyOnly: false,
          amazonPage: this.config.amazonPage,
          alexaServiceHost: this.config.alexaServiceHost,
          acceptLanguage: this.config.acceptLanguage,
          cookieRefreshInterval: this.config.cookieRefreshInterval,
          usePushConnection: false,
          bluetooth: false,
        },
        (err?: Error) => {
          if (err) {
            reject(
              new AlexaAuthError(
                `não consegui usar a sessão salva (${err.message}). Rode "npm run auth" de novo.`,
              ),
            );
            return;
          }
          resolve();
        },
      );
    });

    return remote;
  }

  /** Chama um método do alexa-remote2 e devolve o corpo da resposta. */
  async call<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    const remote = await this.ready();
    const fn = remote[method];
    if (typeof fn !== "function") {
      throw new AlexaApiError(`método desconhecido do alexa-remote2: ${method}`);
    }

    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new AlexaApiError(`${method} não respondeu em ${this.config.requestTimeoutMs}ms`));
      }, this.config.requestTimeoutMs);

      let settled = false;
      const done = (err: Error | undefined, body: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(new AlexaApiError(`${method}: ${err.message}`));
        else resolve(body as T);
      };

      try {
        (fn as (...callArgs: unknown[]) => void).call(remote, ...args, done);
      } catch (error) {
        clearTimeout(timer);
        reject(new AlexaApiError(`${method}: ${(error as Error).message}`));
      }
    });
  }

  /** Os Echos da conta, já em lista. */
  async devices(): Promise<AlexaDevice[]> {
    const remote = await this.ready();
    return Object.values(remote.serialNumbers ?? {});
  }

  /** Resolve o dispositivo pedido, ou o padrão de ALEXA_DEFAULT_DEVICE. */
  async findDevice(query?: string): Promise<AlexaDevice> {
    const wanted = query ?? this.config.defaultDevice;
    if (!wanted) {
      throw new DeviceNotFoundError(
        "nenhum dispositivo informado. Passe o nome do Echo ou defina ALEXA_DEFAULT_DEVICE.",
      );
    }
    return matchDevice(await this.devices(), wanted);
  }
}
