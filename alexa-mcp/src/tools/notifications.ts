import { z } from "zod";

import type { AlexaClient } from "../client.js";
import { AlexaApiError } from "../errors.js";
import type { ToolServer } from "./types.js";
import { guard, ok } from "./result.js";

export interface AlexaNotification {
  id?: string;
  notificationIndex?: string;
  type?: string;
  status?: string;
  reminderLabel?: string | null;
  timerLabel?: string | null;
  alarmTime?: number;
  originalDate?: string;
  originalTime?: string;
  remainingTime?: number;
  deviceSerialNumber?: string;
}

export function summarizeNotifications(
  notifications: AlexaNotification[],
  deviceNames: Map<string, string>,
): Record<string, unknown>[] {
  return (notifications ?? [])
    .filter((item) => item.status !== "DELETED")
    .map((item) => ({
      id: item.id ?? item.notificationIndex ?? null,
      type: item.type ?? null,
      label: item.reminderLabel ?? item.timerLabel ?? null,
      status: item.status ?? null,
      when: item.originalDate
        ? `${item.originalDate} ${item.originalTime ?? ""}`.trim()
        : item.alarmTime
          ? new Date(item.alarmTime).toISOString()
          : null,
      remainingMs: item.remainingTime ?? null,
      device: item.deviceSerialNumber ? (deviceNames.get(item.deviceSerialNumber) ?? null) : null,
    }));
}

export function registerNotificationTools(server: ToolServer, client: AlexaClient): void {
  server.registerTool(
    "list_notifications",
    {
      title: "Listar alarmes, timers e lembretes",
      description:
        "Mostra os alarmes, timers e lembretes ativos na conta, com o dispositivo de cada um.",
      inputSchema: {
        type: z
          .enum(["all", "Alarm", "Timer", "Reminder"])
          .default("all")
          .describe("Filtra por tipo."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ type }) =>
      guard(async () => {
        const response = await client.call<{ notifications?: AlexaNotification[] }>(
          "getNotifications",
          false,
        );
        const devices = await client.devices();
        const names = new Map(devices.map((device) => [device.serialNumber, device.accountName]));
        const all = summarizeNotifications(response?.notifications ?? [], names);
        const filtered = type === "all" ? all : all.filter((item) => item.type === type);
        return ok(`${filtered.length} notificação(ões).`, filtered);
      }),
  );

  server.registerTool(
    "create_reminder",
    {
      title: "Criar lembrete",
      description:
        "Cria um lembrete num Echo. A hora vai no formato ISO 8601 com o fuso, " +
        "p.ex. 2026-09-23T19:30:00-03:00.",
      inputSchema: {
        device: z.string().optional().describe("Echo onde o lembrete toca."),
        when: z.string().min(1).describe("Data e hora em ISO 8601."),
        label: z.string().min(1).max(200).describe("O texto do lembrete."),
      },
    },
    async ({ device, when, label }) =>
      guard(async () => {
        const timestamp = Date.parse(when);
        if (Number.isNaN(timestamp)) {
          throw new AlexaApiError(`data inválida: "${when}". Use ISO 8601, p.ex. 2026-09-23T19:30:00-03:00.`);
        }
        if (timestamp <= Date.now()) {
          throw new AlexaApiError("a data do lembrete precisa estar no futuro.");
        }
        const target = await client.findDevice(device);
        await client.call("setReminder", target.serialNumber, timestamp, label);
        return ok(`Lembrete "${label}" criado em "${target.accountName}" para ${new Date(timestamp).toISOString()}.`);
      }),
  );

  server.registerTool(
    "cancel_notification",
    {
      title: "Cancelar alarme, timer ou lembrete",
      description: "Cancela uma notificação pelo id devolvido por list_notifications.",
      inputSchema: {
        id: z.string().min(1).describe("Id da notificação."),
      },
    },
    async ({ id }) =>
      guard(async () => {
        const response = await client.call<{ notifications?: AlexaNotification[] }>(
          "getNotifications",
          false,
        );
        const found = (response?.notifications ?? []).find(
          (item) => item.id === id || item.notificationIndex === id,
        );
        if (!found) {
          throw new AlexaApiError(`notificação "${id}" não encontrada.`);
        }
        await client.call("deleteNotification", found);
        return ok(`Notificação ${id} cancelada.`);
      }),
  );
}
