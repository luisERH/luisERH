import type { AlexaClient } from "../client.js";
import { registerDeviceTools } from "./devices.js";
import { registerListTools } from "./lists.js";
import { registerNotificationTools } from "./notifications.js";
import { registerRoutineTools } from "./routines.js";
import { registerSmartHomeTools } from "./smarthome.js";
import type { ToolServer } from "./types.js";

export function registerAllTools(server: ToolServer, client: AlexaClient): void {
  registerDeviceTools(server, client);
  registerRoutineTools(server, client);
  registerSmartHomeTools(server, client);
  registerListTools(server, client);
  registerNotificationTools(server, client);
}
