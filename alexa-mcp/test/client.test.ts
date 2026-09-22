import { existsSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { AlexaClient, matchDevice, normalize } from "../src/client.js";
import { loadAuth, saveAuth } from "../src/auth-store.js";
import { AlexaApiError, AlexaAuthError, DeviceNotFoundError } from "../src/errors.js";
import { DEVICES, FakeRemote, makeHarness } from "./fake-remote.js";

describe("matchDevice", () => {
  it("acha pelo número de série", () => {
    expect(matchDevice(DEVICES, "G000BBB222").accountName).toBe("Quarto");
  });

  it("ignora caixa e acento no nome", () => {
    expect(matchDevice(DEVICES, "sala de estar").serialNumber).toBe("G000AAA111");
    expect(matchDevice(DEVICES, "SALA DE ESTÁR").serialNumber).toBe("G000AAA111");
  });

  it("aceita trecho do nome quando ele é único", () => {
    expect(matchDevice(DEVICES, "cozinha").serialNumber).toBe("G000CCC333");
  });

  it("recusa um trecho ambíguo e lista as opções", () => {
    const devices = [...DEVICES, { ...DEVICES[0]!, accountName: "Sala de Jantar", serialNumber: "X" }];
    expect(() => matchDevice(devices, "sala")).toThrow(/mais de um dispositivo/);
    expect(() => matchDevice(devices, "sala")).toThrow(/Sala de Estar, Sala de Jantar/);
  });

  it("lista o que existe quando não acha nada", () => {
    expect(() => matchDevice(DEVICES, "garagem")).toThrow(DeviceNotFoundError);
    expect(() => matchDevice(DEVICES, "garagem")).toThrow(/Cozinha, Quarto, Sala de Estar/);
  });
});

describe("normalize", () => {
  it("tira acentos e caixa", () => {
    expect(normalize("  Sala de Estár ")).toBe("sala de estar");
  });
});

describe("AlexaClient", () => {
  it("conecta uma vez só e reaproveita a sessão", async () => {
    const { client, remote } = makeHarness();
    await client.devices();
    await client.devices();
    expect(remote.argsFor("init")).toHaveLength(1);
  });

  it("manda a marketplace e o idioma configurados para o alexa-remote2", async () => {
    const { client, remote } = makeHarness({ amazonPage: "amazon.com.br", acceptLanguage: "pt-BR" });
    await client.devices();
    const options = remote.argsFor("init")[0]?.[0] as Record<string, unknown>;
    expect(options.amazonPage).toBe("amazon.com.br");
    expect(options.acceptLanguage).toBe("pt-BR");
    expect(options.proxyOnly).toBe(false);
  });

  it("explica o que fazer quando não há sessão salva", async () => {
    const { client } = makeHarness({ authFile: "/tmp/nao-existe-alexa-mcp/auth.json" });
    await expect(client.devices()).rejects.toThrow(AlexaAuthError);
    await expect(client.devices()).rejects.toThrow(/npm run auth/);
  });

  it("transforma erro da Amazon em AlexaApiError", async () => {
    const { client, remote } = makeHarness();
    remote.failures.set("getLists", "500 Internal Server Error");
    await expect(client.call("getLists")).rejects.toThrow(AlexaApiError);
    await expect(client.call("getLists")).rejects.toThrow(/getLists: 500/);
  });

  it("recusa método que o alexa-remote2 não tem", async () => {
    const { client, remote } = makeHarness();
    // `has` no proxy responde por tudo, então o método precisa existir de fato
    Object.defineProperty(remote, "metodoInexistente", { value: 42, configurable: true });
    await expect(client.call("metodoInexistente")).rejects.toThrow(/método desconhecido/);
  });

  it("desiste quando a Amazon não responde", async () => {
    const { client, remote } = makeHarness({ requestTimeoutMs: 20 });
    Object.defineProperty(remote, "getLists", { value: () => {}, configurable: true });
    await expect(client.call("getLists")).rejects.toThrow(/não respondeu em 20ms/);
  });

  it("permite tentar de novo depois de uma falha de conexão", async () => {
    const { client, remote } = makeHarness();
    remote.initError = new Error("cookie expirado");
    await expect(client.devices()).rejects.toThrow(AlexaAuthError);
    remote.initError = null;
    await expect(client.devices()).resolves.toHaveLength(3);
  });

  it("usa ALEXA_DEFAULT_DEVICE quando a ferramenta não informa o dispositivo", async () => {
    const { client } = makeHarness({ defaultDevice: "Quarto" });
    expect((await client.findDevice()).serialNumber).toBe("G000BBB222");
  });

  it("cobra um dispositivo quando não há padrão", async () => {
    const { client } = makeHarness();
    await expect(client.findDevice()).rejects.toThrow(/ALEXA_DEFAULT_DEVICE/);
  });

  it("salva a sessão de novo quando o cookie é renovado", async () => {
    const { client, remote, config } = makeHarness();
    await client.devices();
    remote.cookieData = { localCookie: "cookie-novo" };
    remote.emit("cookie");
    expect(loadAuth(config.authFile)).toEqual({ localCookie: "cookie-novo" });
  });
});

describe("auth store", () => {
  it("grava a sessão sem deixar outros usuários lerem", () => {
    const { config } = makeHarness();
    saveAuth(config.authFile, { localCookie: "segredo" });
    expect(existsSync(config.authFile)).toBe(true);
    expect(statSync(config.authFile).mode & 0o077).toBe(0);
  });

  it("trata arquivo corrompido como ausência de sessão", () => {
    const { config } = makeHarness();
    saveAuth(config.authFile, { ok: true });
    const fake = new FakeRemote();
    expect(fake.serialNumbers).toBeDefined();
    expect(loadAuth("/tmp/nao-existe-alexa-mcp/auth.json")).toBeNull();
  });
});
