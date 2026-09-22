import { z } from "zod";

import type { AlexaClient } from "../client.js";
import { normalize } from "../client.js";
import { AlexaApiError } from "../errors.js";
import type { ToolServer } from "./types.js";
import { guard, ok } from "./result.js";

export interface Routine {
  automationId?: string;
  name?: string | null;
  status?: string;
  triggers?: { payload?: { utterance?: string } }[];
}

/** O nome que uma rotina tem no app, ou a frase que a dispara quando ela não tem nome. */
export function routineLabel(routine: Routine): string {
  const utterance = routine.triggers?.find((trigger) => trigger.payload?.utterance)?.payload?.utterance;
  return routine.name?.trim() || utterance || routine.automationId || "(sem nome)";
}

/** Casa pelo id exato, depois pelo rótulo exato e por fim por trecho do rótulo. */
export function matchRoutine(routines: Routine[], query: string): Routine {
  const byId = routines.find((routine) => routine.automationId === query);
  if (byId) return byId;

  const wanted = normalize(query);
  const exact = routines.filter((routine) => normalize(routineLabel(routine)) === wanted);
  if (exact.length === 1) return exact[0]!;

  const partial = routines.filter((routine) => normalize(routineLabel(routine)).includes(wanted));
  if (partial.length === 1) return partial[0]!;

  if (partial.length > 1) {
    throw new AlexaApiError(
      `"${query}" casa com mais de uma rotina: ${partial.map(routineLabel).join(", ")}.`,
    );
  }
  throw new AlexaApiError(
    `rotina "${query}" não encontrada. Disponíveis: ${routines.map(routineLabel).join(", ") || "nenhuma"}.`,
  );
}

export function registerRoutineTools(server: ToolServer, client: AlexaClient): void {
  server.registerTool(
    "list_routines",
    {
      title: "Listar rotinas",
      description:
        "Lista as rotinas configuradas na conta Alexa, com o nome, a frase que dispara cada uma e " +
        "se está ativa.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).default(100).describe("Máximo de rotinas a listar."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) =>
      guard(async () => {
        const routines = await client.call<Routine[]>("getAutomationRoutines", limit);
        const list = (routines ?? []).map((routine) => ({
          id: routine.automationId,
          name: routineLabel(routine),
          utterance: routine.triggers?.find((t) => t.payload?.utterance)?.payload?.utterance ?? null,
          enabled: routine.status !== "DISABLED",
        }));
        return ok(`${list.length} rotina(s).`, list);
      }),
  );

  server.registerTool(
    "run_routine",
    {
      title: "Executar rotina",
      description:
        "Executa uma rotina existente pelo nome (ou pela frase que a dispara). O dispositivo " +
        "informado é onde a rotina roda, quando ela depende disso.",
      inputSchema: {
        routine: z.string().min(1).describe("Nome da rotina, frase de disparo ou id."),
        device: z.string().optional().describe("Echo onde executar; padrão é ALEXA_DEFAULT_DEVICE."),
      },
    },
    async ({ routine, device }) =>
      guard(async () => {
        const target = await client.findDevice(device);
        const routines = await client.call<Routine[]>("getAutomationRoutines", 500);
        const chosen = matchRoutine(routines ?? [], routine);
        // A API quer a definição inteira da rotina, não só o id.
        await client.call("executeAutomationRoutine", target.serialNumber, chosen);
        return ok(`Rotina "${routineLabel(chosen)}" executada em "${target.accountName}".`);
      }),
  );
}
