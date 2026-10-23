import { Context, Volatile } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { IncomingMessage, ServerResponse } from "node:http";

//#region src/types.d.ts
type OneBotTransport = "forward-ws" | "reverse-ws" | "http";
type OneBotAccessMode = "disabled" | "allowlist" | "blocklist";
interface OneBotConfig {
  transport: OneBotTransport;
  url: string;
  listenHost: string;
  listenPort: number;
  listenPath: string;
  accessTokenRef: string;
  webhookSecretRef: string;
  reconnectInterval: number;
  requestTimeout: number;
  heartbeatTimeout: number;
  commandPrefix: string;
  respondToPrivate: boolean;
  respondToGroup: boolean;
  groupMentionOnly: boolean;
  userAccessMode: OneBotAccessMode;
  userIds: readonly string[];
  groupAccessMode: OneBotAccessMode;
  groupIds: readonly string[];
}
type OneBotEditableConfig = OneBotConfig;
type OneBotConfigPatch = Partial<OneBotConfig>;
//#endregion
//#region src/config.d.ts
declare const Config: z<Volatile<OneBotConfig>>;
//#endregion
//#region src/gateway.d.ts
interface OneBotSettingsBridge {
  source(): OneBotConfig;
}
interface WebServer {
  register(route: {
    kind: "prefix";
    path: string;
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
  }): () => void;
}
declare module "@deepseek-ai/cordis" {
  interface Context {
    webServer: WebServer;
  }
}
declare function registerOneBotConfigGateway(ctx: Context, bridge: OneBotSettingsBridge): void;
//#endregion
//#region src/index.d.ts
declare const name = "onebot";
declare const inject: string[];
declare function apply(ctx: Context, config: Volatile<OneBotConfig>): void;
//#endregion
export { Config, type OneBotAccessMode, type OneBotConfig, type OneBotConfigPatch, type OneBotEditableConfig, type OneBotTransport, apply, inject, name, registerOneBotConfigGateway };