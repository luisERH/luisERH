import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AlexaClient, type AlexaDevice, type RemoteLike } from "../src/client.js";
import { loadConfig, type Config } from "../src/config.js";
import type { ToolResult } from "../src/tools/result.js";

export interface RecordedCall {
  method: string;
  args: unknown[];
}

export const DEVICES: AlexaDevice[] = [
  {
    accountName: "Sala de Estar",
    serialNumber: "G000AAA111",
    deviceType: "ECHO_DOT",
    deviceTypeFriendlyName: "Echo Dot",
    online: true,
    capabilities: ["AUDIO_PLAYER", "VOLUME_SETTING"],
  },
  {
    accountName: "Quarto",
    serialNumber: "G000BBB222",
    deviceType: "ECHO_SHOW",
    deviceTypeFriendlyName: "Echo Show",
    online: false,
    capabilities: ["AUDIO_PLAYER"],
  },
  {
    accountName: "Cozinha",
    serialNumber: "G000CCC333",
    deviceType: "ECHO_DOT",
    online: true,
    capabilities: [],
  },
];

/** Duplo do alexa-remote2: registra as chamadas e devolve respostas preparadas. */
export class FakeRemote implements RemoteLike {
  serialNumbers: Record<string, AlexaDevice> = {};
  cookieData: unknown = { localCookie: "cookie-de-teste" };
  calls: RecordedCall[] = [];
  responses = new Map<string, unknown>();
  failures = new Map<string, string>();
  initError: Error | null = null;
  private listeners = new Map<string, ((...args: unknown[]) => void)[]>();

  [method: string]: unknown;

  constructor(devices: AlexaDevice[] = DEVICES) {
    for (const device of devices) this.serialNumbers[device.serialNumber] = device;
    // As chamadas da API são resolvidas por nome, então um proxy cobre todas de uma vez.
    // `then` fica de fora: sem isso o duplo viraria um thenable e quebraria qualquer
    // Promise que o resolvesse.
    const notApiMethods = new Set(["then", "catch", "finally", "constructor"]);
    return new Proxy(this, {
      get(target, property, receiver) {
        if (typeof property === "string" && !notApiMethods.has(property) && !(property in target)) {
          return (...args: unknown[]) => {
            const callback = args[args.length - 1] as (err?: Error, body?: unknown) => void;
            const rest = args.slice(0, -1);
            target.calls.push({ method: property, args: rest });
            const failure = target.failures.get(property);
            if (failure) {
              callback(new Error(failure));
              return;
            }
            callback(undefined, target.responses.get(property));
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  init(options: unknown, callback: (err?: Error) => void): void {
    this.calls.push({ method: "init", args: [options] });
    setImmediate(() => callback(this.initError ?? undefined));
  }

  /** Chamadas de um método, sem o callback. */
  argsFor(method: string): unknown[][] {
    return this.calls.filter((call) => call.method === method).map((call) => call.args);
  }
}

/** Um servidor MCP falso que só guarda os handlers para o teste chamar. */
export class CapturingServer {
  handlers = new Map<string, (args: Record<string, unknown>) => Promise<ToolResult>>();
  configs = new Map<string, Record<string, unknown>>();

  registerTool(
    name: string,
    config: Record<string, unknown>,
    handler: (args: never, extra: never) => unknown,
  ): unknown {
    this.configs.set(name, config);
    this.handlers.set(name, async (args: Record<string, unknown>) => {
      return (await (handler as (a: unknown, e: unknown) => Promise<ToolResult>)(args, {})) as ToolResult;
    });
    return {};
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`ferramenta não registrada: ${name}`);
    return handler(args);
  }
}

export interface Harness {
  client: AlexaClient;
  remote: FakeRemote;
  server: CapturingServer;
  config: Config;
}

/** Monta client + servidor falsos com uma sessão salva num diretório temporário. */
export function makeHarness(overrides: Partial<Config> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "alexa-mcp-test-"));
  const authFile = join(dir, "auth.json");
  writeFileSync(authFile, JSON.stringify({ localCookie: "cookie-de-teste" }));
  const config: Config = { ...loadConfig({}), authFile, defaultDevice: undefined, ...overrides };
  const remote = new FakeRemote();
  const client = new AlexaClient(config, () => remote);
  return { client, remote, server: new CapturingServer(), config };
}

/** O JSON que a ferramenta anexou ao resumo. */
export function payload<T = unknown>(result: ToolResult): T {
  const text = result.content[0]?.text ?? "";
  const start = text.indexOf("\n\n");
  if (start === -1) throw new Error(`resultado sem JSON: ${text}`);
  return JSON.parse(text.slice(start + 2)) as T;
}

export function summary(result: ToolResult): string {
  const text = result.content[0]?.text ?? "";
  const end = text.indexOf("\n\n");
  return end === -1 ? text : text.slice(0, end);
}
