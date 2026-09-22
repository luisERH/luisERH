import { z } from "zod";

import type { AlexaClient } from "../client.js";
import { normalize } from "../client.js";
import { AlexaApiError } from "../errors.js";
import type { ToolServer } from "./types.js";
import { guard, ok } from "./result.js";

export interface SmartHomeEndpoint {
  endpointId?: string;
  friendlyName?: string;
  displayCategories?: { primary?: { value?: string } };
  legacyAppliance?: {
    applianceId?: string;
    entityId?: string;
    friendlyName?: string;
    manufacturerName?: string;
    applianceTypes?: string[];
    actions?: string[];
    isEnabled?: boolean;
  };
}

export interface SmartHomeSummary {
  name: string;
  entityId: string | null;
  applianceId: string | null;
  category: string | null;
  manufacturer: string | null;
  actions: string[];
  enabled: boolean | null;
}

/** Reduz a resposta GraphQL da Amazon ao que serve para escolher e acionar um aparelho. */
export function summarizeEndpoints(items: SmartHomeEndpoint[]): SmartHomeSummary[] {
  return (items ?? []).map((item) => {
    const legacy = item.legacyAppliance ?? {};
    return {
      name: item.friendlyName ?? legacy.friendlyName ?? "(sem nome)",
      entityId: legacy.entityId ?? null,
      applianceId: legacy.applianceId ?? null,
      category: item.displayCategories?.primary?.value ?? legacy.applianceTypes?.[0] ?? null,
      manufacturer: legacy.manufacturerName ?? null,
      actions: legacy.actions ?? [],
      enabled: legacy.isEnabled ?? null,
    };
  });
}

export function matchEndpoint(items: SmartHomeSummary[], query: string): SmartHomeSummary {
  const byId = items.find((item) => item.entityId === query || item.applianceId === query);
  if (byId) return byId;

  const wanted = normalize(query);
  const exact = items.filter((item) => normalize(item.name) === wanted);
  if (exact.length === 1) return exact[0]!;

  const partial = items.filter((item) => normalize(item.name).includes(wanted));
  if (partial.length === 1) return partial[0]!;

  if (partial.length > 1) {
    throw new AlexaApiError(
      `"${query}" casa com mais de um aparelho: ${partial.map((i) => i.name).join(", ")}.`,
    );
  }
  throw new AlexaApiError(
    `aparelho "${query}" não encontrado. Disponíveis: ${items.map((i) => i.name).join(", ") || "nenhum"}.`,
  );
}

/** Monta o corpo que a API /api/phoenix/state espera para cada ação. */
export function buildAction(
  action: string,
  value: number | string | undefined,
): Record<string, unknown> {
  switch (action) {
    case "turnOn":
    case "turnOff":
      return { action };
    case "setBrightness":
      return { action, brightness: requireNumber(action, value) };
    case "setPercentage":
      return { action, percentage: requireNumber(action, value) };
    case "setColor":
      return { action, colorName: requireString(action, value) };
    case "setColorTemperature":
      return { action, colorTemperatureName: requireString(action, value) };
    case "setTargetTemperature":
      return {
        action,
        targetTemperature: { value: requireNumber(action, value), scale: "CELSIUS" },
      };
    default:
      throw new AlexaApiError(`ação desconhecida: ${action}`);
  }
}

function requireNumber(action: string, value: number | string | undefined): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (parsed === undefined || Number.isNaN(parsed)) {
    throw new AlexaApiError(`a ação ${action} precisa de um valor numérico.`);
  }
  return parsed;
}

function requireString(action: string, value: number | string | undefined): string {
  if (value === undefined || value === "") {
    throw new AlexaApiError(`a ação ${action} precisa de um valor de texto.`);
  }
  return String(value);
}

export function registerSmartHomeTools(server: ToolServer, client: AlexaClient): void {
  server.registerTool(
    "list_smarthome_devices",
    {
      title: "Listar aparelhos da casa",
      description:
        "Lista os aparelhos de casa inteligente pareados com a Alexa (lâmpadas, tomadas, " +
        "termostatos) com o id que as outras ferramentas usam e as ações que cada um aceita.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      guard(async () => {
        const items = await client.call<SmartHomeEndpoint[]>("getSmarthomeDevicesV2");
        const summary = summarizeEndpoints(items ?? []);
        return ok(`${summary.length} aparelho(s) na casa inteligente.`, summary);
      }),
  );

  server.registerTool(
    "list_smarthome_groups",
    {
      title: "Listar grupos da casa",
      description: "Lista os grupos/cômodos da casa inteligente configurados na Alexa.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      guard(async () => {
        const groups = await client.call<{ applianceGroups?: unknown[] }>("getSmarthomeGroups");
        return ok("Grupos da casa inteligente.", groups?.applianceGroups ?? groups);
      }),
  );

  server.registerTool(
    "get_smarthome_state",
    {
      title: "Estado de um aparelho",
      description:
        "Consulta o estado atual de um aparelho (ligado/desligado, brilho, temperatura). " +
        "Aceita o nome do aparelho ou o entityId vindo de list_smarthome_devices.",
      inputSchema: {
        device: z.string().min(1).describe("Nome ou entityId do aparelho."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ device }) =>
      guard(async () => {
        const items = summarizeEndpoints(
          await client.call<SmartHomeEndpoint[]>("getSmarthomeDevicesV2"),
        );
        const chosen = matchEndpoint(items, device);
        if (!chosen.entityId) {
          throw new AlexaApiError(`o aparelho "${chosen.name}" não expõe um entityId consultável.`);
        }
        const state = await client.call("querySmarthomeDevices", [chosen.entityId], "APPLIANCE");
        return ok(`Estado de "${chosen.name}".`, state);
      }),
  );

  server.registerTool(
    "control_smarthome_device",
    {
      title: "Acionar aparelho da casa",
      description:
        "Liga, desliga ou ajusta um aparelho da casa inteligente. Ações: turnOn, turnOff, " +
        "setBrightness (0-100), setPercentage (0-100), setColor (nome da cor, p.ex. 'red'), " +
        "setColorTemperature (p.ex. 'warm_white') e setTargetTemperature (graus Celsius).",
      inputSchema: {
        device: z.string().min(1).describe("Nome ou entityId do aparelho."),
        action: z
          .enum([
            "turnOn",
            "turnOff",
            "setBrightness",
            "setPercentage",
            "setColor",
            "setColorTemperature",
            "setTargetTemperature",
          ])
          .describe("O que fazer com o aparelho."),
        value: z
          .union([z.number(), z.string()])
          .optional()
          .describe("Valor da ação, quando ela precisar de um."),
      },
    },
    async ({ device, action, value }) =>
      guard(async () => {
        const items = summarizeEndpoints(
          await client.call<SmartHomeEndpoint[]>("getSmarthomeDevicesV2"),
        );
        const chosen = matchEndpoint(items, device);
        if (!chosen.entityId) {
          throw new AlexaApiError(`o aparelho "${chosen.name}" não expõe um entityId acionável.`);
        }
        const parameters = buildAction(action, value);
        const response = await client.call(
          "executeSmarthomeDeviceAction",
          [chosen.entityId],
          parameters,
          "APPLIANCE",
        );
        const errors = (response as { errors?: unknown[] } | undefined)?.errors;
        if (Array.isArray(errors) && errors.length > 0) {
          return ok(`A Amazon recusou a ação em "${chosen.name}".`, errors);
        }
        return ok(`"${chosen.name}": ${action} aplicado.`);
      }),
  );
}
