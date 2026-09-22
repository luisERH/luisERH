import { z } from "zod";

import type { AlexaClient, AlexaDevice } from "../client.js";
import type { ToolServer } from "./types.js";
import { guard, ok } from "./result.js";

const deviceArg = z.string().describe("Nome do Echo (como aparece no app Alexa) ou número de série.");

interface VolumeEntry {
  dsn?: string;
  speakerVolume?: number;
  speakerMuted?: boolean;
}

interface DndEntry {
  deviceSerialNumber?: string;
  enabled?: boolean;
}

/** Junta o que a Amazon devolve em três chamadas separadas num registro só por dispositivo. */
export function describeDevices(
  devices: AlexaDevice[],
  volumes: VolumeEntry[],
  dnd: DndEntry[],
): Record<string, unknown>[] {
  return devices.map((device) => {
    const volume = volumes.find((entry) => entry.dsn === device.serialNumber);
    const doNotDisturb = dnd.find((entry) => entry.deviceSerialNumber === device.serialNumber);
    return {
      name: device.accountName,
      serialNumber: device.serialNumber,
      type: device.deviceTypeFriendlyName ?? device.deviceFamily ?? device.deviceType,
      online: device.online ?? null,
      volume: volume?.speakerVolume ?? null,
      muted: volume?.speakerMuted ?? null,
      doNotDisturb: doNotDisturb?.enabled ?? null,
      canPlayMusic: device.capabilities?.includes("AUDIO_PLAYER") ?? null,
    };
  });
}

export function registerDeviceTools(server: ToolServer, client: AlexaClient): void {
  server.registerTool(
    "list_devices",
    {
      title: "Listar dispositivos Alexa",
      description:
        "Lista os Echos da conta com nome, número de série, estado online, volume atual e " +
        "'não perturbe'. Use antes das outras ferramentas para descobrir os nomes exatos.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      guard(async () => {
        const devices = await client.devices();
        // As duas chamadas extras são opcionais: sem elas a lista ainda serve.
        const volumes = await client
          .call<{ volumes?: VolumeEntry[] }>("getAllDeviceVolumes")
          .catch(() => ({ volumes: [] }));
        const dnd = await client.call<DndEntry[]>("getAllDoNotDisturbDeviceStatus").catch(() => []);
        const described = describeDevices(devices, volumes?.volumes ?? [], Array.isArray(dnd) ? dnd : []);
        return ok(`${described.length} dispositivo(s) na conta.`, described);
      }),
  );

  server.registerTool(
    "speak",
    {
      title: "Falar no Echo",
      description:
        "Faz o Echo falar um texto. 'announcement' toca o som de anúncio antes (e vai para todos " +
        "os dispositivos informados), 'speak' fala direto e 'ssml' aceita marcação SSML.",
      inputSchema: {
        device: deviceArg,
        text: z.string().min(1).max(1000).describe("O que a Alexa deve falar."),
        mode: z
          .enum(["announcement", "speak", "ssml"])
          .default("speak")
          .describe("Como falar: anúncio, fala direta ou SSML."),
      },
    },
    async ({ device, text, mode }) =>
      guard(async () => {
        const target = await client.findDevice(device);
        await client.call("sendSequenceCommand", target.serialNumber, mode, text);
        return ok(`Falei em "${target.accountName}".`);
      }),
  );

  server.registerTool(
    "send_voice_command",
    {
      title: "Enviar comando de voz",
      description:
        "Manda uma frase para a Alexa como se você tivesse falado com ela ('toque jazz na sala', " +
        "'desligue a luz do quarto', 'que horas são'). É o caminho mais direto para qualquer coisa " +
        "que as outras ferramentas não cobrem — a Alexa responde no próprio dispositivo.",
      inputSchema: {
        device: deviceArg,
        phrase: z.string().min(1).max(500).describe("A frase, exatamente como você falaria."),
      },
    },
    async ({ device, phrase }) =>
      guard(async () => {
        const target = await client.findDevice(device);
        await client.call("sendSequenceCommand", target.serialNumber, "textCommand", phrase);
        return ok(`Comando enviado para "${target.accountName}": ${phrase}`);
      }),
  );

  server.registerTool(
    "set_volume",
    {
      title: "Ajustar volume",
      description: "Define o volume do Echo, de 0 a 100.",
      inputSchema: {
        device: deviceArg,
        volume: z.number().int().min(0).max(100).describe("Volume de 0 a 100."),
      },
    },
    async ({ device, volume }) =>
      guard(async () => {
        const target = await client.findDevice(device);
        await client.call("sendSequenceCommand", target.serialNumber, "volume", volume);
        return ok(`Volume de "${target.accountName}" em ${volume}.`);
      }),
  );

  server.registerTool(
    "control_playback",
    {
      title: "Controlar a reprodução",
      description: "Play, pause, próxima ou anterior no que estiver tocando no Echo.",
      inputSchema: {
        device: deviceArg,
        action: z.enum(["play", "pause", "next", "previous"]).describe("O que fazer com a mídia."),
      },
    },
    async ({ device, action }) =>
      guard(async () => {
        const target = await client.findDevice(device);
        await client.call("sendCommand", target.serialNumber, action, "");
        return ok(`"${action}" enviado para "${target.accountName}".`);
      }),
  );

  server.registerTool(
    "set_do_not_disturb",
    {
      title: "Não perturbe",
      description: "Liga ou desliga o 'não perturbe' de um Echo, ou de todos de uma vez.",
      inputSchema: {
        device: deviceArg.optional().describe("Dispositivo; omita junto com all=true para todos."),
        enabled: z.boolean().describe("true liga o não perturbe, false desliga."),
        all: z.boolean().default(false).describe("true aplica a todos os dispositivos da conta."),
      },
    },
    async ({ device, enabled, all }) =>
      guard(async () => {
        const targets = all ? await client.devices() : [await client.findDevice(device)];
        for (const target of targets) {
          await client.call("setDoNotDisturb", target.serialNumber, enabled);
        }
        const label = all ? `${targets.length} dispositivo(s)` : `"${targets[0]?.accountName}"`;
        return ok(`Não perturbe ${enabled ? "ligado" : "desligado"} em ${label}.`);
      }),
  );

  server.registerTool(
    "rename_device",
    {
      title: "Renomear dispositivo",
      description:
        "Troca o nome de um Echo na conta Alexa. O nome novo é o que você vai usar por voz e nas " +
        "outras ferramentas.",
      inputSchema: {
        device: deviceArg,
        newName: z.string().min(1).max(60).describe("Novo nome do dispositivo."),
      },
      annotations: { idempotentHint: true },
    },
    async ({ device, newName }) =>
      guard(async () => {
        const target = await client.findDevice(device);
        await client.call("renameDevice", target.serialNumber, newName);
        return ok(`"${target.accountName}" agora se chama "${newName}".`);
      }),
  );
}
