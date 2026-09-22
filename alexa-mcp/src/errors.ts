/** Falta login, ou a sessão salva não vale mais. */
export class AlexaAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlexaAuthError";
  }
}

/** A Amazon respondeu com erro, ou a chamada estourou o tempo. */
export class AlexaApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlexaApiError";
  }
}

/** O nome do dispositivo não casou com nada, ou casou com coisa demais. */
export class DeviceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceNotFoundError";
  }
}
