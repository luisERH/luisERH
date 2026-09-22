import { AlexaApiError, AlexaAuthError, DeviceNotFoundError } from "../errors.js";

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** Resposta de sucesso: uma linha para o humano, o JSON para o modelo. */
export function ok(summary: string, data?: unknown): ToolResult {
  const text = data === undefined ? summary : `${summary}\n\n${JSON.stringify(data, null, 2)}`;
  return { content: [{ type: "text", text }] };
}

export function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Converte as falhas previstas em mensagens que o modelo consegue agir em cima,
 * em vez de derrubar a conexão MCP.
 */
export async function guard(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AlexaAuthError) {
      return fail(`Sessão da Amazon indisponível: ${error.message}`);
    }
    if (error instanceof DeviceNotFoundError || error instanceof AlexaApiError) {
      return fail(error.message);
    }
    return fail(`Erro inesperado: ${(error as Error).message}`);
  }
}
