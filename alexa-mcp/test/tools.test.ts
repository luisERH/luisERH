import { beforeEach, describe, expect, it } from "vitest";

import { registerAllTools } from "../src/tools/index.js";
import { buildAction, matchEndpoint, summarizeEndpoints } from "../src/tools/smarthome.js";
import { matchRoutine, routineLabel } from "../src/tools/routines.js";
import { describeDevices } from "../src/tools/devices.js";
import { CapturingServer, DEVICES, FakeRemote, makeHarness, payload, summary } from "./fake-remote.js";

let harness: ReturnType<typeof makeHarness>;
let server: CapturingServer;
let remote: FakeRemote;

beforeEach(() => {
  harness = makeHarness();
  server = harness.server;
  remote = harness.remote;
  registerAllTools(server, harness.client);
});

describe("registro das ferramentas", () => {
  it("expõe o conjunto esperado", () => {
    expect([...server.handlers.keys()].sort()).toEqual(
      [
        "add_list_item",
        "cancel_notification",
        "control_playback",
        "control_smarthome_device",
        "create_reminder",
        "get_list_items",
        "get_lists",
        "get_smarthome_state",
        "list_devices",
        "list_notifications",
        "list_routines",
        "list_smarthome_devices",
        "list_smarthome_groups",
        "rename_device",
        "run_routine",
        "send_voice_command",
        "set_do_not_disturb",
        "set_volume",
        "speak",
      ].sort(),
    );
  });

  it("marca as ferramentas de leitura como read-only", () => {
    const annotations = server.configs.get("list_devices")?.annotations as Record<string, unknown>;
    expect(annotations.readOnlyHint).toBe(true);
  });
});

describe("list_devices", () => {
  it("junta volume e não perturbe no mesmo registro", async () => {
    remote.responses.set("getAllDeviceVolumes", {
      volumes: [{ dsn: "G000AAA111", speakerVolume: 42, speakerMuted: false }],
    });
    remote.responses.set("getAllDoNotDisturbDeviceStatus", [
      { deviceSerialNumber: "G000AAA111", enabled: true },
    ]);

    const result = await server.call("list_devices");
    const devices = payload<Record<string, unknown>[]>(result);
    expect(summary(result)).toBe("3 dispositivo(s) na conta.");
    expect(devices[0]).toMatchObject({
      name: "Sala de Estar",
      serialNumber: "G000AAA111",
      volume: 42,
      doNotDisturb: true,
      online: true,
    });
  });

  it("ainda lista os dispositivos se volume e DND falharem", async () => {
    remote.failures.set("getAllDeviceVolumes", "503");
    remote.failures.set("getAllDoNotDisturbDeviceStatus", "503");
    const devices = payload<Record<string, unknown>[]>(await server.call("list_devices"));
    expect(devices).toHaveLength(3);
    expect(devices[0]?.volume).toBeNull();
  });

  it("describeDevices deixa nulo o que a Amazon não informou", () => {
    const described = describeDevices([DEVICES[2]!], [], []);
    expect(described[0]).toMatchObject({ name: "Cozinha", volume: null, doNotDisturb: null });
  });
});

describe("falar e comandar", () => {
  it("fala no dispositivo achado pelo nome sem acento", async () => {
    const result = await server.call("speak", { device: "sala de estar", text: "Oi", mode: "speak" });
    expect(remote.argsFor("sendSequenceCommand")[0]).toEqual(["G000AAA111", "speak", "Oi"]);
    expect(summary(result)).toContain("Sala de Estar");
  });

  it("usa o modo anúncio quando pedido", async () => {
    await server.call("speak", { device: "Quarto", text: "Jantar pronto", mode: "announcement" });
    expect(remote.argsFor("sendSequenceCommand")[0]).toEqual([
      "G000BBB222",
      "announcement",
      "Jantar pronto",
    ]);
  });

  it("manda a frase como comando de voz", async () => {
    await server.call("send_voice_command", { device: "Cozinha", phrase: "toque jazz" });
    expect(remote.argsFor("sendSequenceCommand")[0]).toEqual([
      "G000CCC333",
      "textCommand",
      "toque jazz",
    ]);
  });

  it("ajusta o volume", async () => {
    await server.call("set_volume", { device: "Quarto", volume: 30 });
    expect(remote.argsFor("sendSequenceCommand")[0]).toEqual(["G000BBB222", "volume", 30]);
  });

  it("controla a reprodução", async () => {
    await server.call("control_playback", { device: "Quarto", action: "pause" });
    expect(remote.argsFor("sendCommand")[0]).toEqual(["G000BBB222", "pause", ""]);
  });

  it("devolve erro legível quando o dispositivo não existe", async () => {
    const result = await server.call("speak", { device: "Garagem", text: "Oi", mode: "speak" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("não encontrado");
    expect(remote.argsFor("sendSequenceCommand")).toHaveLength(0);
  });

  it("devolve erro legível quando a Amazon recusa", async () => {
    remote.failures.set("sendSequenceCommand", "401 Unauthorized");
    const result = await server.call("speak", { device: "Quarto", text: "Oi", mode: "speak" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("401");
  });
});

describe("não perturbe e renomear", () => {
  it("aplica a todos quando all=true", async () => {
    await server.call("set_do_not_disturb", { enabled: true, all: true });
    expect(remote.argsFor("setDoNotDisturb")).toEqual([
      ["G000AAA111", true],
      ["G000BBB222", true],
      ["G000CCC333", true],
    ]);
  });

  it("aplica a um dispositivo só", async () => {
    await server.call("set_do_not_disturb", { device: "Quarto", enabled: false, all: false });
    expect(remote.argsFor("setDoNotDisturb")).toEqual([["G000BBB222", false]]);
  });

  it("renomeia pelo nome atual", async () => {
    const result = await server.call("rename_device", { device: "Cozinha", newName: "Copa" });
    expect(remote.argsFor("renameDevice")[0]).toEqual(["G000CCC333", "Copa"]);
    expect(summary(result)).toContain("Copa");
  });
});

describe("rotinas", () => {
  const routines = [
    { automationId: "amzn1.alexa.automation.1", name: "Bom dia", triggers: [] },
    {
      automationId: "amzn1.alexa.automation.2",
      name: null,
      triggers: [{ payload: { utterance: "boa noite" } }],
    },
  ];

  it("lista nome, frase e estado", async () => {
    remote.responses.set("getAutomationRoutines", routines);
    const list = payload<Record<string, unknown>[]>(await server.call("list_routines", { limit: 100 }));
    expect(list).toHaveLength(2);
    expect(list[1]).toMatchObject({ name: "boa noite", utterance: "boa noite", enabled: true });
  });

  it("executa passando a definição inteira, como a API exige", async () => {
    remote.responses.set("getAutomationRoutines", routines);
    await server.call("run_routine", { routine: "bom dia", device: "Quarto" });
    expect(remote.argsFor("executeAutomationRoutine")[0]).toEqual(["G000BBB222", routines[0]]);
  });

  it("acha a rotina pela frase de disparo", () => {
    expect(routineLabel(matchRoutine(routines, "boa noite"))).toBe("boa noite");
  });

  it("recusa rotina ambígua", () => {
    const ambiguous = [
      { automationId: "a", name: "Luzes da sala" },
      { automationId: "b", name: "Luzes do quarto" },
    ];
    expect(() => matchRoutine(ambiguous, "luzes")).toThrow(/mais de uma rotina/);
  });
});

describe("casa inteligente", () => {
  const endpoints = [
    {
      endpointId: "endpoint-1",
      friendlyName: "Lâmpada da Sala",
      displayCategories: { primary: { value: "LIGHT" } },
      legacyAppliance: {
        applianceId: "appliance-1",
        entityId: "entity-1",
        manufacturerName: "Tuya",
        actions: ["turnOn", "turnOff", "setBrightness"],
        isEnabled: true,
      },
    },
    {
      endpointId: "endpoint-2",
      friendlyName: "Tomada da Cozinha",
      legacyAppliance: { applianceId: "appliance-2", entityId: "entity-2", actions: ["turnOn"] },
    },
  ];

  it("resume o retorno do GraphQL no que importa", () => {
    const summaryList = summarizeEndpoints(endpoints);
    expect(summaryList[0]).toEqual({
      name: "Lâmpada da Sala",
      entityId: "entity-1",
      applianceId: "appliance-1",
      category: "LIGHT",
      manufacturer: "Tuya",
      actions: ["turnOn", "turnOff", "setBrightness"],
      enabled: true,
    });
  });

  it("aciona pelo nome, com acento ou sem", async () => {
    remote.responses.set("getSmarthomeDevicesV2", endpoints);
    await server.call("control_smarthome_device", { device: "lampada da sala", action: "turnOn" });
    expect(remote.argsFor("executeSmarthomeDeviceAction")[0]).toEqual([
      ["entity-1"],
      { action: "turnOn" },
      "APPLIANCE",
    ]);
  });

  it("repassa o erro da Amazon quando o aparelho está fora do ar", async () => {
    remote.responses.set("getSmarthomeDevicesV2", endpoints);
    remote.responses.set("executeSmarthomeDeviceAction", {
      errors: [{ code: "ENDPOINT_UNREACHABLE" }],
    });
    const result = await server.call("control_smarthome_device", {
      device: "Tomada da Cozinha",
      action: "turnOn",
    });
    expect(summary(result)).toContain("recusou");
    expect(payload(result)).toEqual([{ code: "ENDPOINT_UNREACHABLE" }]);
  });

  it("monta o corpo certo para cada ação", () => {
    expect(buildAction("setBrightness", 40)).toEqual({ action: "setBrightness", brightness: 40 });
    expect(buildAction("setColor", "red")).toEqual({ action: "setColor", colorName: "red" });
    expect(buildAction("setTargetTemperature", 21)).toEqual({
      action: "setTargetTemperature",
      targetTemperature: { value: 21, scale: "CELSIUS" },
    });
  });

  it("cobra o valor das ações que precisam de um", () => {
    expect(() => buildAction("setBrightness", undefined)).toThrow(/valor numérico/);
    expect(() => buildAction("setColor", undefined)).toThrow(/valor de texto/);
  });

  it("acha o aparelho pelo entityId", () => {
    expect(matchEndpoint(summarizeEndpoints(endpoints), "entity-2").name).toBe("Tomada da Cozinha");
  });

  it("consulta o estado pelo entityId do aparelho", async () => {
    remote.responses.set("getSmarthomeDevicesV2", endpoints);
    remote.responses.set("querySmarthomeDevices", { deviceStates: [] });
    await server.call("get_smarthome_state", { device: "Tomada da Cozinha" });
    expect(remote.argsFor("querySmarthomeDevices")[0]).toEqual([["entity-2"], "APPLIANCE"]);
  });
});

describe("listas", () => {
  const lists = [
    { listId: "lista-1", name: "Compras", type: "SHOPPING_LIST" },
    { listId: "lista-2", name: "Tarefas", type: "TO_DO" },
  ];

  it("esconde os itens já marcados por padrão", async () => {
    remote.responses.set("getListsV2", lists);
    remote.responses.set("getListItemsV2", [
      { id: "i1", value: "café", completed: false },
      { id: "i2", value: "pão", completed: true },
    ]);
    const items = payload<Record<string, unknown>[]>(
      await server.call("get_list_items", { list: "compras", includeCompleted: false }),
    );
    expect(items).toEqual([{ id: "i1", value: "café", completed: false, version: null }]);
  });

  it("adiciona item na lista certa", async () => {
    remote.responses.set("getListsV2", lists);
    await server.call("add_list_item", { list: "Tarefas", item: "pagar a conta" });
    expect(remote.argsFor("addListItem")[0]).toEqual(["lista-2", { value: "pagar a conta" }]);
  });

  it("explica quando a lista não existe", async () => {
    remote.responses.set("getListsV2", lists);
    const result = await server.call("add_list_item", { list: "mercado", item: "x" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Compras, Tarefas");
  });
});

describe("alarmes, timers e lembretes", () => {
  it("lista com o nome do dispositivo resolvido", async () => {
    remote.responses.set("getNotifications", {
      notifications: [
        {
          id: "n1",
          type: "Reminder",
          status: "ON",
          reminderLabel: "Remédio",
          deviceSerialNumber: "G000AAA111",
          originalDate: "2026-09-23",
          originalTime: "19:30:00",
        },
        { id: "n2", type: "Timer", status: "DELETED" },
      ],
    });
    const items = payload<Record<string, unknown>[]>(await server.call("list_notifications", { type: "all" }));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "n1", label: "Remédio", device: "Sala de Estar" });
  });

  it("cria lembrete com a hora em epoch", async () => {
    const when = new Date(Date.now() + 3_600_000).toISOString();
    await server.call("create_reminder", { device: "Quarto", when, label: "Reunião" });
    expect(remote.argsFor("setReminder")[0]).toEqual([
      "G000BBB222",
      Date.parse(when),
      "Reunião",
    ]);
  });

  it("recusa data no passado", async () => {
    const result = await server.call("create_reminder", {
      device: "Quarto",
      when: "2020-01-01T10:00:00-03:00",
      label: "Tarde demais",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("futuro");
  });

  it("recusa data que não dá para interpretar", async () => {
    const result = await server.call("create_reminder", {
      device: "Quarto",
      when: "amanhã de manhã",
      label: "x",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("ISO 8601");
  });

  it("cancela passando a notificação inteira", async () => {
    const notification = { id: "n1", type: "Alarm", status: "ON" };
    remote.responses.set("getNotifications", { notifications: [notification] });
    await server.call("cancel_notification", { id: "n1" });
    expect(remote.argsFor("deleteNotification")[0]).toEqual([notification]);
  });
});
