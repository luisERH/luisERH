import { z } from "zod";

import type { AlexaClient } from "../client.js";
import { normalize } from "../client.js";
import { AlexaApiError } from "../errors.js";
import type { ToolServer } from "./types.js";
import { guard, ok } from "./result.js";

export interface AlexaList {
  listId?: string;
  name?: string;
  type?: string;
  totalActiveItemsCount?: string | number;
}

export interface AlexaListItem {
  id?: string;
  itemId?: string;
  value?: string;
  itemName?: string;
  completed?: boolean;
  status?: string;
  version?: number | string;
}

/** O nome de uma lista, que às vezes vem só no tipo ("SHOPPING_LIST"). */
export function listLabel(list: AlexaList): string {
  return list.name?.trim() || list.type || list.listId || "(sem nome)";
}

export function matchList(lists: AlexaList[], query: string): AlexaList {
  const byId = lists.find((list) => list.listId === query);
  if (byId) return byId;

  const wanted = normalize(query);
  const hit = lists.filter((list) => normalize(listLabel(list)).includes(wanted));
  if (hit.length === 1) return hit[0]!;
  if (hit.length > 1) {
    throw new AlexaApiError(`"${query}" casa com mais de uma lista: ${hit.map(listLabel).join(", ")}.`);
  }
  throw new AlexaApiError(
    `lista "${query}" não encontrada. Disponíveis: ${lists.map(listLabel).join(", ") || "nenhuma"}.`,
  );
}

export function summarizeItems(items: AlexaListItem[]): Record<string, unknown>[] {
  return (items ?? []).map((item) => ({
    id: item.id ?? item.itemId ?? null,
    value: item.value ?? item.itemName ?? "",
    completed: item.completed ?? item.status === "COMPLETED",
    version: item.version ?? null,
  }));
}

export function registerListTools(server: ToolServer, client: AlexaClient): void {
  server.registerTool(
    "get_lists",
    {
      title: "Listar listas da Alexa",
      description: "Mostra as listas da conta (compras, tarefas e as que você criou).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      guard(async () => {
        const lists = await client.call<AlexaList[]>("getListsV2");
        const summary = (lists ?? []).map((list) => ({
          id: list.listId,
          name: listLabel(list),
          type: list.type ?? null,
        }));
        return ok(`${summary.length} lista(s).`, summary);
      }),
  );

  server.registerTool(
    "get_list_items",
    {
      title: "Ver itens de uma lista",
      description: "Mostra os itens de uma lista da Alexa. Aceita o nome ou o id da lista.",
      inputSchema: {
        list: z.string().min(1).describe("Nome ou id da lista (p.ex. 'compras')."),
        includeCompleted: z.boolean().default(false).describe("true inclui os itens já marcados."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ list, includeCompleted }) =>
      guard(async () => {
        const lists = await client.call<AlexaList[]>("getListsV2");
        const chosen = matchList(lists ?? [], list);
        const items = await client.call<AlexaListItem[]>("getListItemsV2", chosen.listId, {});
        const summary = summarizeItems(items ?? []).filter(
          (item) => includeCompleted || item.completed !== true,
        );
        return ok(`${summary.length} item(ns) em "${listLabel(chosen)}".`, summary);
      }),
  );

  server.registerTool(
    "add_list_item",
    {
      title: "Adicionar item à lista",
      description: "Acrescenta um item a uma lista da Alexa (compras, tarefas ou outra).",
      inputSchema: {
        list: z.string().min(1).describe("Nome ou id da lista."),
        item: z.string().min(1).max(200).describe("O que adicionar."),
      },
    },
    async ({ list, item }) =>
      guard(async () => {
        const lists = await client.call<AlexaList[]>("getListsV2");
        const chosen = matchList(lists ?? [], list);
        await client.call("addListItem", chosen.listId, { value: item });
        return ok(`"${item}" adicionado em "${listLabel(chosen)}".`);
      }),
  );
}
