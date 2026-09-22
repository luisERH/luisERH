import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Os dados de sessão da Amazon (`cookieData` do alexa-remote2). Vale o mesmo que a sua
 * senha, então o arquivo é gravado só para o dono (0600) dentro de um diretório 0700.
 */
export type StoredAuth = Record<string, unknown>;

export function saveAuth(file: string, data: StoredAuth): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function loadAuth(file: string): StoredAuth | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as StoredAuth;
  } catch {
    return null;
  }
}

export function hasAuth(file: string): boolean {
  return loadAuth(file) !== null;
}
