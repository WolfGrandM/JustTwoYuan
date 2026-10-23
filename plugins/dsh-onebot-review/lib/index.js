import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { Agent, fetch as fetch$1 } from "undici";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import WebSocket, { WebSocketServer } from "ws";

//#region src/config.ts
const Config = z.object({
	transport: z.union([
		"forward-ws",
		"reverse-ws",
		"http"
	]).default("forward-ws").description("传输模式"),
	url: z.string().default("ws://127.0.0.1:3001").description("正向 WebSocket 地址或 HTTP API 基础地址"),
	listenHost: z.string().default("127.0.0.1").description("反向 WebSocket 或 HTTP webhook 监听地址"),
	listenPort: z.number().default(3002).min(1).max(65535).step(1).description("监听端口"),
	listenPath: z.string().default("/onebot").description("反向 WebSocket 或 HTTP webhook 监听路径"),
	accessTokenRef: z.string().default("ONEBOT_ACCESS_TOKEN").description("访问令牌的 DSH 凭据引用"),
	webhookSecretRef: z.string().default("ONEBOT_WEBHOOK_SECRET").description("webhook 签名密钥的 DSH 凭据引用"),
	reconnectInterval: z.number().default(5e3).min(0).step(1).description("断线重连间隔（毫秒）"),
	requestTimeout: z.number().default(3e4).min(1).step(1).description("OneBot API 请求超时（毫秒）"),
	heartbeatTimeout: z.number().default(12e4).min(0).step(1).description("心跳超时（毫秒，0 表示禁用）"),
	commandPrefix: z.string().default("").description("命令前缀（留空表示不启用前缀门控）"),
	respondToPrivate: z.boolean().default(true).description("是否响应私聊消息"),
	respondToGroup: z.boolean().default(true).description("是否响应群聊消息"),
	groupMentionOnly: z.boolean().default(true).description("群聊中是否仅响应提及机器人的消息"),
	userAccessMode: z.union([
		"disabled",
		"allowlist",
		"blocklist"
	]).default("disabled").description("用户访问控制模式"),
	userIds: z.array(z.string()).default([]).description("用户 ID 列表"),
	groupAccessMode: z.union([
		"disabled",
		"allowlist",
		"blocklist"
	]).default("disabled").description("群访问控制模式"),
	groupIds: z.array(z.string()).default([]).description("群 ID 列表")
}).volatile();

//#endregion
//#region src/gateway.ts
const editableKeys = new Set([
	"transport",
	"url",
	"listenHost",
	"listenPort",
	"listenPath",
	"accessTokenRef",
	"webhookSecretRef",
	"reconnectInterval",
	"requestTimeout",
	"heartbeatTimeout",
	"commandPrefix",
	"respondToPrivate",
	"respondToGroup",
	"groupMentionOnly",
	"userAccessMode",
	"userIds",
	"groupAccessMode",
	"groupIds"
]);
function editable(config) {
	return { ...config };
}
function validatePatch(patch) {
	for (const key of Object.keys(patch)) if (!editableKeys.has(key)) throw new Error(`onebot: unknown configuration field "${key}"`);
	if (patch.transport !== void 0 && ![
		"forward-ws",
		"reverse-ws",
		"http"
	].includes(patch.transport)) throw new Error("onebot: invalid transport");
	for (const key of [
		"url",
		"listenHost",
		"listenPath"
	]) if (patch[key] !== void 0 && patch[key].trim() === "") throw new Error(`onebot: ${key} must not be empty`);
	if (patch.listenPort !== void 0 && (!Number.isSafeInteger(patch.listenPort) || patch.listenPort < 1 || patch.listenPort > 65535)) throw new Error("onebot: listenPort must be an integer between 1 and 65535");
	for (const key of ["reconnectInterval", "heartbeatTimeout"]) if (patch[key] !== void 0 && (!Number.isSafeInteger(patch[key]) || patch[key] < 0)) throw new Error(`onebot: ${key} must be a non-negative safe integer`);
	if (patch.requestTimeout !== void 0 && (!Number.isSafeInteger(patch.requestTimeout) || patch.requestTimeout < 1)) throw new Error("onebot: requestTimeout must be a positive safe integer");
	for (const key of ["userAccessMode", "groupAccessMode"]) if (patch[key] !== void 0 && ![
		"disabled",
		"allowlist",
		"blocklist"
	].includes(patch[key])) throw new Error(`onebot: invalid ${key}`);
	for (const key of ["userIds", "groupIds"]) if (patch[key] !== void 0 && (!Array.isArray(patch[key]) || patch[key].some((id) => typeof id !== "string"))) throw new Error(`onebot: ${key} must be an array of strings`);
}
function registerOneBotConfigGateway(ctx, bridge) {
	let settings;
	ctx.inject(["settings"], (sctx) => {
		settings = sctx.settings;
		return () => {
			settings = void 0;
		};
	});
	ctx.inject(["webServer"], (sctx) => sctx.effect(() => sctx.webServer.register({
		kind: "prefix",
		path: "/onebot/api",
		handler: (request, response) => handleRequest(request, response, bridge, settings, ctx.fiber.entry?.options.id)
	}), "onebot: settings API"));
}
async function handleRequest(request, response, bridge, settings, namespace) {
	if (request.method !== "POST") return writeJson(response, 405, failure("method-not-allowed", "POST only"));
	const contentType = request.headers["content-type"];
	if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("application/json")) return writeJson(response, 415, failure("unsupported-media-type", "application/json required"));
	const host = request.headers.host;
	const origin = request.headers.origin;
	const fetchSite = request.headers["sec-fetch-site"];
	if (host === void 0 || !isLoopbackHost$1(host) || fetchSite === "cross-site" || origin !== void 0 && new URL(origin).host !== host) return writeJson(response, 403, failure("forbidden-origin", "trusted same-origin request required"));
	const pathname = new URL(request.url ?? "/", "http://dsh.internal").pathname;
	const method = pathname.startsWith("/onebot/api/") ? pathname.slice(12) : "";
	try {
		if (method === "get") {
			writeJson(response, 200, success({
				config: editable(bridge.source()),
				writable: settings?.writable === true
			}));
			return;
		}
		if (method === "set") {
			const patch = (await readJson(request)).patch;
			if (typeof patch !== "object" || patch === null || Array.isArray(patch)) throw new Error("onebot: set requires a plain-object patch");
			validatePatch(patch);
			if (Object.keys(patch).length > 0) {
				if (settings === void 0 || namespace === void 0) throw new Error("onebot: settings service or plugin entry is unavailable");
				await settings.update(namespace, patch);
			}
			writeJson(response, 200, success({
				config: editable(bridge.source()),
				writable: settings?.writable === true
			}));
			return;
		}
		writeJson(response, 404, failure("not-found", "unknown OneBot settings method"));
	} catch (error) {
		writeJson(response, 400, failure("invalid-request", error instanceof Error ? error.message : String(error)));
	}
}
async function readJson(request) {
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > 64 * 1024) throw new Error("onebot: settings request is too large");
		chunks.push(buffer);
	}
	const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("onebot: settings request must be a JSON object");
	return value;
}
function isLoopbackHost$1(authority) {
	try {
		const hostname = new URL(`http://${authority}`).hostname;
		if (hostname === "localhost" || hostname === "[::1]") return true;
		const parts = hostname.split(".");
		return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
	} catch {
		return false;
	}
}
function success(value) {
	return {
		ok: true,
		value
	};
}
function failure(code, message) {
	return {
		ok: false,
		error: {
			code,
			message
		}
	};
}
function writeJson(response, status, body) {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(body));
}

//#endregion
//#region src/protocol.ts
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isId(value) {
	return typeof value === "string" || typeof value === "number" && Number.isFinite(value);
}
function decodeCq(value, parameter = false) {
	const decoded = value.replace(/&#91;/g, "[").replace(/&#93;/g, "]");
	return (parameter ? decoded.replace(/&#44;/g, ",") : decoded).replace(/&amp;/g, "&");
}
function cqSegments(message) {
	const segments = [];
	const pattern = /\[CQ:([^,\]]+)((?:,[^,\]]+=[^,\]]*)*)\]/g;
	let offset = 0;
	for (const match of message.matchAll(pattern)) {
		const index = match.index;
		if (index > offset) segments.push({
			type: "text",
			data: { text: decodeCq(message.slice(offset, index)) }
		});
		const data = {};
		for (const item of match[2].slice(1).split(",")) {
			if (!item) continue;
			const separator = item.indexOf("=");
			if (separator >= 0) data[item.slice(0, separator)] = decodeCq(item.slice(separator + 1), true);
		}
		segments.push({
			type: match[1],
			data
		});
		offset = index + match[0].length;
	}
	if (offset < message.length) segments.push({
		type: "text",
		data: { text: decodeCq(message.slice(offset)) }
	});
	return segments;
}
function normalizeSegments(value) {
	if (!Array.isArray(value)) return void 0;
	const segments = [];
	for (const valueSegment of value) {
		if (!isRecord(valueSegment) || typeof valueSegment.type !== "string") return void 0;
		if (valueSegment.data !== null && !isRecord(valueSegment.data)) return void 0;
		segments.push({
			type: valueSegment.type,
			data: valueSegment.data ?? {}
		});
	}
	return segments;
}
function parseEvent(value) {
	if (!isRecord(value) || typeof value.post_type !== "string") return void 0;
	const raw = value;
	if (value.post_type !== "message" && value.post_type !== "message_sent") return {
		...value,
		raw
	};
	const temporaryTarget = value.target_id ?? value.group_id;
	if (value.message_type !== "private" && value.message_type !== "group" || !isId(value.self_id) || !isId(value.user_id) || value.message_id !== void 0 && !isId(value.message_id) || value.target_id !== void 0 && !isId(value.target_id) || value.sub_type !== void 0 && typeof value.sub_type !== "string" || value.message_type === "group" && !isId(value.group_id) || value.message_type === "private" && value.sub_type === "group" && !isId(temporaryTarget)) return void 0;
	const segments = normalizeSegments(value.message);
	if (typeof value.message !== "string" && segments === void 0 && typeof value.raw_message !== "string") return void 0;
	const message = typeof value.message === "string" ? value.message : segments ?? value.raw_message;
	const rawMessage = typeof value.raw_message === "string" ? value.raw_message : typeof message === "string" ? message : message.map((segment) => segment.type === "text" && typeof segment.data.text === "string" ? segment.data.text : "").join("");
	return {
		...value,
		...value.message_type === "private" && value.sub_type === "group" ? { target_id: temporaryTarget } : {},
		message,
		raw_message: rawMessage,
		raw
	};
}
function isMessageEvent(event) {
	return (event.post_type === "message" || event.post_type === "message_sent") && "message_type" in event && "user_id" in event && "message" in event && "raw_message" in event;
}
function messageSegments(event) {
	return typeof event.message === "string" ? cqSegments(event.message) : event.message;
}
function mentionsSelf(event) {
	const selfId = String(event.self_id);
	return messageSegments(event).some((segment) => segment.type === "at" && String(segment.data.qq) === selfId);
}
function segmentContent(segment, selfId) {
	if (segment.type === "text" && typeof segment.data.text === "string") return segment.data.text;
	if (segment.type === "at") {
		const qq = segment.data.qq;
		if (!isId(qq) && qq !== "all") return "[mention]";
		if (String(qq) === selfId) return "";
		return qq === "all" ? "[mention:all]" : `[mention:${String(qq)}]`;
	}
	if (segment.type === "reply" && isId(segment.data.id)) return `[reply:${String(segment.data.id)}]`;
	if (segment.type === "face" && isId(segment.data.id)) return `[face:${String(segment.data.id)}]`;
	if (segment.type === "record") return "[audio]";
	if (segment.type === "video") return "[video]";
	if (segment.type === "file") {
		const name$1 = segment.data.name ?? segment.data.file;
		return typeof name$1 === "string" || typeof name$1 === "number" ? `[file:${String(name$1)}]` : "[file]";
	}
	if (segment.type === "json" || segment.type === "xml") return `[${segment.type}]`;
	if (segment.type === "forward") {
		const id = segment.data.id;
		return isId(id) ? `[forward:${String(id)}]` : "[forward]";
	}
	return segment.type === "image" ? "" : `[onebot:${segment.type}]`;
}
function messageText(event) {
	return messageSegments(event).map((segment) => segment.type === "text" && typeof segment.data.text === "string" ? segment.data.text : "").join("").trim();
}
function messageContent(event, stripPrefix = "") {
	const selfId = String(event.self_id);
	let remaining = stripPrefix;
	return messageSegments(event).map((segment) => {
		if (segment.type !== "text" || typeof segment.data.text !== "string") return segmentContent(segment, selfId);
		const remove = Math.min(remaining.length, segment.data.text.length);
		remaining = remaining.slice(remove);
		return segment.data.text.slice(remove);
	}).join("").trim();
}
function idAllowed(id, mode, ids) {
	if (mode === "disabled") return true;
	const included = ids.includes(String(id));
	return mode === "allowlist" ? included : !included;
}
function accessAllowed(event, config) {
	if (event.message_type === "private") {
		if (!config.respondToPrivate) return false;
	} else if (!config.respondToGroup || !isId(event.group_id)) return false;
	if (!idAllowed(event.user_id, config.userAccessMode, config.userIds)) return false;
	if (event.message_type === "group") {
		if (!idAllowed(event.group_id, config.groupAccessMode, config.groupIds)) return false;
		if (config.groupMentionOnly && !mentionsSelf(event)) return false;
	}
	return config.commandPrefix === "" || messageText(event).startsWith(config.commandPrefix);
}
function sessionKey(event) {
	const group = event.message_type === "group" ? String(event.group_id) : "-";
	const temporaryTarget = event.message_type === "private" && event.sub_type === "group" && event.target_id !== void 0 ? String(event.target_id) : "-";
	return [
		"onebot",
		event.self_id,
		"onebot-v11",
		event.message_type,
		group,
		temporaryTarget,
		event.user_id
	].map((part) => encodeURIComponent(String(part))).join(":");
}

//#endregion
//#region src/images.ts
const IMAGE_MEDIA_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif"
]);
const MAX_REDIRECTS = 5;
const PUBLIC_IMAGE_AGENT = new Agent({ connect: { async lookup(hostname, options, callback) {
	try {
		const addresses = await lookup(hostname, {
			all: true,
			verbatim: true
		});
		const publicAddresses = addresses.filter(({ address }) => isPublicAddress(address));
		if (publicAddresses.length !== addresses.length || publicAddresses.length === 0) {
			callback(/* @__PURE__ */ new Error("onebot: image URL resolves to a non-public address"), []);
			return;
		}
		if (options.all) callback(null, publicAddresses);
		else callback(null, publicAddresses[0].address, publicAddresses[0].family);
	} catch (error) {
		callback(error, []);
	}
} } });
function isPublicAddress(address) {
	if (isIP(address) === 4) {
		const value = address.split(".").reduce((result, octet) => result * 256 + Number(octet), 0);
		const inRange = (base, bits) => {
			const size = 2 ** (32 - bits);
			return value >= base && value < base + size;
		};
		return ![
			[0, 8],
			[167772160, 8],
			[1681915904, 10],
			[2130706432, 8],
			[2851995648, 16],
			[2886729728, 12],
			[3221225472, 24],
			[3221225984, 24],
			[3227017984, 24],
			[3232235520, 16],
			[3323068416, 15],
			[3325256704, 24],
			[3405803776, 24],
			[3758096384, 4]
		].some(([base, bits]) => inRange(base, bits));
	}
	const normalized = address.toLowerCase();
	if (normalized === "::" || normalized === "::1") return false;
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
	if (mapped !== null) return isPublicAddress(mapped[1]);
	const first = Number.parseInt(normalized.split(":", 1)[0] || "0", 16);
	return (first & 65024) !== 64512 && (first & 65472) !== 65152 && (first & 65472) !== 65216 && (first & 65280) !== 65280 && !normalized.startsWith("2001:db8:");
}
async function publicImageUrl(source) {
	const url = new URL(source);
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("onebot: image URL must use http or https");
	if (url.username !== "" || url.password !== "") throw new Error("onebot: image URL must not contain credentials");
	if (isIP(url.hostname) !== 0 && !isPublicAddress(url.hostname)) throw new Error("onebot: image URL must use a public address");
	return url;
}
function mediaType(value) {
	const type = value?.split(";", 1)[0]?.trim().toLowerCase();
	if (type !== void 0 && IMAGE_MEDIA_TYPES.has(type)) return type;
	throw new Error(`onebot: unsupported image media type ${type ?? "(missing)"}`);
}
function boundedBase64(value, maxBytes) {
	const compact = value.replace(/\s/g, "");
	if (compact.length > Math.ceil(maxBytes / 3) * 4 + 4) throw new Error(`onebot: image exceeds ${maxBytes} bytes`);
	const data = Buffer.from(compact, "base64");
	if (data.byteLength > maxBytes) throw new Error(`onebot: image exceeds ${maxBytes} bytes`);
	return data;
}
function dataImage(source, maxBytes) {
	const match = /^data:([^;,]+);base64,(.*)$/is.exec(source);
	if (match === null) throw new Error("onebot: image data source must be base64 encoded");
	return {
		data: boundedBase64(match[2], maxBytes),
		mediaType: mediaType(match[1])
	};
}
async function httpImage(source, maxBytes, timeoutMs) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		let url = await publicImageUrl(source);
		for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
			const response = await fetch$1(url, {
				dispatcher: PUBLIC_IMAGE_AGENT,
				redirect: "manual",
				signal: controller.signal
			});
			if (response.status >= 300 && response.status < 400) {
				const location = response.headers.get("location");
				if (location === null) throw new Error("onebot: image redirect has no location");
				url = await publicImageUrl(new URL(location, url).href);
				continue;
			}
			if (!response.ok) throw new Error(`onebot: image download failed (${response.status})`);
			const declaredLength = Number(response.headers.get("content-length"));
			if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error(`onebot: image exceeds ${maxBytes} bytes`);
			const type = mediaType(response.headers.get("content-type"));
			if (response.body === null) throw new Error("onebot: image response has no body");
			const chunks = [];
			let length = 0;
			for await (const chunk of response.body) {
				length += chunk.byteLength;
				if (length > maxBytes) throw new Error(`onebot: image exceeds ${maxBytes} bytes`);
				chunks.push(chunk);
			}
			const data = new Uint8Array(length);
			let offset = 0;
			for (const chunk of chunks) {
				data.set(chunk, offset);
				offset += chunk.byteLength;
			}
			return {
				data,
				mediaType: type
			};
		}
		throw new Error(`onebot: image exceeded ${MAX_REDIRECTS} redirects`);
	} finally {
		clearTimeout(timer);
	}
}
async function saveIncomingImages(ctx, sources, requestTimeout) {
	const limits = ctx.attachments.imageLimits;
	if (sources.length > limits.maxImagesPerMessage) throw new Error(`onebot: message exceeds ${limits.maxImagesPerMessage} images`);
	const inputs = [];
	let total = 0;
	for (const source of sources) {
		const input = source.startsWith("data:") ? dataImage(source, limits.maxImageBytes) : source.startsWith("base64://") ? (() => {
			throw new Error("onebot: bare base64 image requires a declared media type");
		})() : await httpImage(source, limits.maxImageBytes, requestTimeout);
		total += input.data.byteLength;
		if (total > limits.maxMessageImageBytes) throw new Error(`onebot: message images exceed ${limits.maxMessageImageBytes} bytes`);
		inputs.push(input);
	}
	await Promise.all(inputs.map((input) => ctx.attachments.validateImage(input)));
	return Promise.all(inputs.map(async (input) => ({
		type: "image",
		attachment: await ctx.attachments.saveImage(input)
	})));
}

//#endregion
//#region src/transport.ts
const MAX_EVENT_BYTES = 1024 * 1024;
function isLoopbackHost(host) {
	const normalized = host.toLowerCase();
	return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}
function rawText(data) {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) return Buffer.from(data).toString();
	if (Array.isArray(data)) return Buffer.concat(data).toString();
	return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString();
}
function normalizedPath(path) {
	return path.startsWith("/") ? path : `/${path}`;
}
var OneBotTransportRuntime = class {
	socket;
	eventSocket;
	server;
	wsServer;
	reconnectTimer;
	heartbeatTimer;
	generation = 0;
	stopped = true;
	nextEcho = 1;
	pending = /* @__PURE__ */ new Map();
	resetTail = Promise.resolve();
	constructor(source, sink, credentials, logger = console) {
		this.source = source;
		this.sink = sink;
		this.credentials = credentials;
		this.logger = logger;
	}
	start() {
		if (!this.stopped) return;
		this.stopped = false;
		this.open();
	}
	restart() {
		if (this.stopped) return;
		this.resetTail = this.resetTail.then(() => this.reset(true));
	}
	async stop() {
		if (this.stopped) return;
		this.stopped = true;
		this.resetTail = this.resetTail.then(() => this.reset(false));
		await this.resetTail;
	}
	async request(action, params) {
		const config = this.source();
		if (config.transport === "http") {
			const token = await this.credentials.accessToken();
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), config.requestTimeout);
			try {
				const base = config.url.endsWith("/") ? config.url : `${config.url}/`;
				const response = await fetch(new URL(encodeURIComponent(action), base), {
					method: "POST",
					headers: {
						"content-type": "application/json",
						...token === void 0 ? {} : { authorization: `Bearer ${token}` }
					},
					body: JSON.stringify(params),
					signal: controller.signal
				});
				if (!response.ok) throw new Error(`onebot: HTTP API failed (${response.status})`);
				return this.actionData(await response.json());
			} finally {
				clearTimeout(timer);
			}
		}
		const socket = this.socket;
		if (socket === void 0 || socket.readyState !== WebSocket.OPEN) throw new Error("onebot: API connection is not open");
		const echo = String(this.nextEcho++);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(echo);
				reject(/* @__PURE__ */ new Error(`onebot: API request timed out after ${config.requestTimeout}ms`));
			}, config.requestTimeout);
			this.pending.set(echo, {
				resolve,
				reject,
				timer
			});
			socket.send(JSON.stringify({
				action,
				params,
				echo
			}), (error) => {
				if (error == null) return;
				const pending = this.pending.get(echo);
				if (pending === void 0) return;
				clearTimeout(pending.timer);
				this.pending.delete(echo);
				reject(error);
			});
		});
	}
	actionData(value) {
		if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
		const response = value;
		const status = response.status;
		const retcode = response.retcode;
		if (status !== void 0 && status !== "ok" || retcode !== void 0 && retcode !== 0) throw new Error(`onebot: API request failed (${String(retcode)}): ${response.wording ?? response.message ?? ""}`);
		if ("data" in response) return response.data;
		if (status === void 0 && retcode === void 0 && "message_id" in response && (typeof response.message_id === "string" || typeof response.message_id === "number")) return response;
		throw new Error(`onebot: API response has no valid result${response.message === void 0 ? "" : `: ${response.message}`}`);
	}
	async open() {
		const generation = this.generation;
		try {
			const mode = this.source().transport;
			if (mode === "forward-ws") await this.openForward(generation);
			else await this.openServer(generation, mode);
		} catch (error) {
			if (!this.stopped && generation === this.generation) {
				this.logger.warn(`onebot: transport failed: ${String(error)}`);
				this.scheduleReconnect();
			}
		}
	}
	async openForward(generation) {
		const token = await this.credentials.accessToken();
		if (this.stopped || generation !== this.generation) return;
		const socket = new WebSocket(this.source().url, {
			headers: token === void 0 ? void 0 : { Authorization: `Bearer ${token}` },
			maxPayload: MAX_EVENT_BYTES
		});
		this.socket = socket;
		socket.on("message", (data) => this.receive(data));
		socket.on("error", (error) => this.logger.warn(`onebot: WebSocket error: ${error.message}`));
		socket.on("close", () => {
			if (this.socket !== socket) return;
			this.socket = void 0;
			this.failPending(/* @__PURE__ */ new Error("onebot: API connection closed"));
			this.scheduleReconnect();
		});
	}
	async openServer(generation, mode) {
		const config = this.source();
		const [token, secret] = await Promise.all([this.credentials.accessToken(), this.credentials.webhookSecret()]);
		if (!isLoopbackHost(config.listenHost)) {
			if (mode === "reverse-ws" && token === void 0) throw new Error("onebot: access token is required when reverse WebSocket listens beyond loopback");
			if (mode === "http" && secret === void 0) throw new Error("onebot: webhook secret is required when HTTP listens beyond loopback");
		}
		if (this.stopped || generation !== this.generation) return;
		const path = normalizedPath(config.listenPath);
		const server = createServer((request, response) => {
			if (mode === "http") this.webhook(request, response, path, secret);
			else {
				response.statusCode = 404;
				response.end();
			}
		});
		this.server = server;
		if (mode === "reverse-ws") {
			const wsServer = new WebSocketServer({
				noServer: true,
				maxPayload: MAX_EVENT_BYTES
			});
			this.wsServer = wsServer;
			server.on("upgrade", (request, socket, head) => {
				if (new URL(request.url ?? "/", "http://localhost").pathname !== path || !this.authorized(request, token)) {
					socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
					socket.destroy();
					return;
				}
				const role = request.headers["x-client-role"];
				const selfId = request.headers["x-self-id"];
				if (role !== "API" && role !== "Event" && role !== "Universal" || typeof selfId !== "string") {
					socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
					socket.destroy();
					return;
				}
				wsServer.handleUpgrade(request, socket, head, (webSocket) => this.acceptReverse(webSocket, role));
			});
		}
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(config.listenPort, config.listenHost, resolve);
		});
	}
	acceptReverse(socket, role) {
		if (role === "API" || role === "Universal") {
			this.socket?.close();
			this.socket = socket;
		}
		if (role === "Event" || role === "Universal") {
			this.eventSocket?.close();
			this.eventSocket = socket;
		}
		socket.on("message", (data) => this.receive(data));
		socket.on("error", (error) => this.logger.warn(`onebot: reverse WebSocket error: ${error.message}`));
		socket.on("close", () => {
			if (this.socket === socket) {
				this.socket = void 0;
				this.failPending(/* @__PURE__ */ new Error("onebot: API connection closed"));
			}
			if (this.eventSocket === socket) this.eventSocket = void 0;
		});
	}
	authorized(request, token) {
		if (token === void 0) return true;
		return request.headers.authorization === `Bearer ${token}`;
	}
	async webhook(request, response, path, secret) {
		try {
			if (request.method !== "POST" || new URL(request.url ?? "/", "http://localhost").pathname !== path) {
				response.statusCode = 404;
				response.end();
				return;
			}
			const chunks = [];
			let length = 0;
			for await (const chunk of request) {
				const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				length += buffer.length;
				if (length > 1024 * 1024) throw new Error("onebot: webhook body is too large");
				chunks.push(buffer);
			}
			const body = Buffer.concat(chunks);
			if (secret !== void 0) {
				const actual = request.headers["x-signature"];
				const expected = `sha1=${createHmac("sha1", secret).update(body).digest("hex")}`;
				if (typeof actual !== "string" || actual.length !== expected.length || !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) {
					response.statusCode = 401;
					response.end();
					return;
				}
			}
			const value = JSON.parse(body.toString());
			const selfId = value?.self_id;
			const headerId = request.headers["x-self-id"];
			if (headerId !== void 0 && String(selfId) !== headerId) {
				response.statusCode = 400;
				response.end();
				return;
			}
			this.observeEvent(value);
			response.statusCode = 204;
			response.end();
		} catch (error) {
			this.logger.warn(`onebot: webhook rejected: ${String(error)}`);
			if (!response.headersSent) response.statusCode = 400;
			response.end();
		}
	}
	receive(data) {
		let value;
		try {
			value = JSON.parse(rawText(data));
		} catch {
			this.logger.warn("onebot: ignored invalid JSON frame");
			return;
		}
		const echo = value?.echo;
		if (typeof echo === "string" || typeof echo === "number") {
			const pending = this.pending.get(String(echo));
			if (pending === void 0) return;
			this.pending.delete(String(echo));
			clearTimeout(pending.timer);
			try {
				pending.resolve(this.actionData(value));
			} catch (error) {
				pending.reject(error);
			}
			return;
		}
		this.observeEvent(value);
	}
	observeEvent(value) {
		const event = value;
		if (event.post_type === "meta_event" && event.meta_event_type === "heartbeat") this.armHeartbeat();
		this.sink(value);
	}
	armHeartbeat() {
		const timeout = this.source().heartbeatTimeout;
		if (this.heartbeatTimer !== void 0) clearTimeout(this.heartbeatTimer);
		if (timeout === 0) {
			this.heartbeatTimer = void 0;
			return;
		}
		this.heartbeatTimer = setTimeout(() => {
			this.logger.warn(`onebot: heartbeat timed out after ${timeout}ms`);
			if (this.source().transport === "forward-ws") this.restart();
			else this.eventSocket?.close();
		}, timeout);
	}
	scheduleReconnect() {
		if (this.stopped || this.source().transport !== "forward-ws" || this.reconnectTimer !== void 0) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = void 0;
			this.open();
		}, this.source().reconnectInterval);
	}
	async reset(reopen) {
		this.generation += 1;
		if (this.reconnectTimer !== void 0) clearTimeout(this.reconnectTimer);
		if (this.heartbeatTimer !== void 0) clearTimeout(this.heartbeatTimer);
		this.reconnectTimer = this.heartbeatTimer = void 0;
		const socket = this.socket;
		const eventSocket = this.eventSocket;
		this.socket = this.eventSocket = void 0;
		socket?.close();
		if (eventSocket !== socket) eventSocket?.close();
		this.wsServer?.close();
		this.wsServer = void 0;
		const server = this.server;
		this.server = void 0;
		if (server !== void 0) await new Promise((resolve) => server.close(() => resolve()));
		this.failPending(/* @__PURE__ */ new Error("onebot: transport restarted"));
		if (reopen && !this.stopped) await this.open();
	}
	failPending(error) {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}
};
function createOneBotTransport(source, sink, credentials, logger) {
	return new OneBotTransportRuntime(source, sink, credentials, logger);
}

//#endregion
//#region src/onebot.ts
function replyMessageId(value) {
	if (typeof value === "string" || typeof value === "number") return value;
	if (value !== null && typeof value === "object" && "message_id" in value) {
		const id = value.message_id;
		if (typeof id === "string" || typeof id === "number") return id;
	}
	throw new Error("onebot: send action returned no message_id");
}
var OneBotClient = class {
	transport;
	sessions = /* @__PURE__ */ new Map();
	sessionPromises = /* @__PURE__ */ new Map();
	seenMessageIds = /* @__PURE__ */ new Set();
	seenMessageOrder = [];
	stopped = true;
	constructor(ctx, source) {
		this.ctx = ctx;
		this.source = source;
		const resolveCredential = async (ref) => {
			return (await ctx.get("credentials")?.resolve(credentialRef(ref)))?.value;
		};
		this.transport = createOneBotTransport(source, (value) => this.receive(value), {
			accessToken: () => resolveCredential(source().accessTokenRef),
			webhookSecret: () => resolveCredential(source().webhookSecretRef)
		}, ctx.logger);
	}
	start() {
		this.stopped = false;
		this.transport.start();
	}
	restart() {
		if (!this.stopped) this.transport.restart();
	}
	async stop() {
		this.stopped = true;
		await this.transport.stop();
		await Promise.allSettled([...this.sessionPromises.values()]);
		await Promise.allSettled([...this.sessions.values()].map((entry) => entry.tail));
		await Promise.allSettled([...this.sessions.values()].map((entry) => entry.handle.dispose()));
		this.sessions.clear();
		this.sessionPromises.clear();
	}
	receive(value) {
		const event = parseEvent(value);
		if (event === void 0) {
			this.ctx.logger.warn("onebot: ignored malformed event");
			return;
		}
		if (!isMessageEvent(event)) return;
		if (event.post_type === "message_sent" || !accessAllowed(event, this.source()) || this.duplicate(event)) return;
		const text = messageContent(event, this.source().commandPrefix);
		const imageSources = messageSegments(event).filter((segment) => segment.type === "image").map((segment) => typeof segment.data.url === "string" ? segment.data.url : segment.data.file).filter((source) => typeof source === "string" && /^(?:https?:|data:|base64:\/\/)/i.test(source));
		if (text === "" && imageSources.length === 0) return;
		const key = sessionKey(event);
		this.enqueue(key, event, text, imageSources).catch((error) => {
			this.ctx.logger.warn(`onebot: message handling failed: ${String(error)}`);
		});
	}
	duplicate(event) {
		if (event.message_id === void 0) return false;
		const key = `${event.self_id}:${event.message_type}:${event.message_id}`;
		if (this.seenMessageIds.has(key)) return true;
		this.seenMessageIds.add(key);
		this.seenMessageOrder.push(key);
		if (this.seenMessageOrder.length > 4096) {
			const oldest = this.seenMessageOrder.shift();
			if (oldest !== void 0) this.seenMessageIds.delete(oldest);
		}
		return false;
	}
	async enqueue(key, event, text, images) {
		const entry = await this.session(key, event);
		if (this.stopped) throw new Error("onebot: client is stopped");
		const work = entry.tail.then(() => this.run(entry, event, text, images));
		entry.tail = work.catch(() => {});
		await work;
	}
	session(key, event) {
		const existing = this.sessions.get(key);
		if (existing !== void 0) return Promise.resolve(existing);
		const pending = this.sessionPromises.get(key);
		if (pending !== void 0) return pending;
		const creation = this.createSession(key, event).finally(() => this.sessionPromises.delete(key));
		this.sessionPromises.set(key, creation);
		return creation;
	}
	async createSession(key, event) {
		if (this.stopped) throw new Error("onebot: client is stopped");
		const selection = this.ctx.agentDefaultModel.currentSelection();
		const sessionId = SessionId(key);
		const reply = { active: false };
		const setup = (agentCtx) => {
			installModelSelection(agentCtx, {
				current: selection,
				assembled: void 0
			});
			const temporaryTarget = event.message_type === "private" && event.sub_type === "group" ? `, temporary_group_id=${String(event.target_id)}` : "";
			agentCtx.systemPrompt.context({
				name: "onebot:message-source",
				order: 100,
				text: `OneBot v11 message source: self_id=${String(event.self_id)}, message_type=${event.message_type}, sub_type=${event.sub_type ?? "unknown"}, user_id=${String(event.user_id)}${event.group_id === void 0 ? "" : `, group_id=${String(event.group_id)}`}${temporaryTarget}. Reply only by calling onebot_reply.`
			});
			agentCtx.tools.register(this.replyTool(reply));
		};
		const options = {
			agentOptions: {
				provider: selection.provider,
				model: selection.model
			},
			setup
		};
		const persistence = this.ctx.get("sessionPersistence");
		const handle = (persistence === void 0 ? false : (await persistence.list()).some((snapshot) => snapshot.header.id === sessionId)) ? await this.ctx.agents.resume({
			resumeSessionId: sessionId,
			...options
		}) : await this.ctx.agents.create({
			sessionId,
			meta: { cwd: process.cwd() },
			...options
		});
		if (this.stopped) {
			await handle.dispose();
			throw new Error("onebot: client is stopped");
		}
		const entry = {
			handle,
			tail: Promise.resolve(),
			reply
		};
		this.sessions.set(key, entry);
		return entry;
	}
	replyTool(state) {
		return defineTool({
			name: "onebot_reply",
			description: "Set the final reply for the current OneBot turn. Later calls replace the earlier candidate.",
			parameters: {
				text: {
					type: "string",
					description: "Reply text. Omit when sending only images."
				},
				images: {
					type: "array",
					items: { type: "string" },
					description: "Optional image sources accepted by the OneBot implementation."
				},
				quote: {
					type: "boolean",
					description: "Quote the inbound message in the reply. Defaults to true when it has an ID."
				}
			},
			output: {
				schema: { type: "string" },
				render: (_args, value) => [{
					type: "text",
					text: value
				}]
			},
			execute: async (args) => {
				if (!state.active) throw new Error("onebot_reply is only available while processing an inbound OneBot message");
				const images = args.images ?? [];
				if ((args.text === void 0 || args.text === "") && images.length === 0) throw new Error("onebot_reply requires text or at least one image");
				state.candidate = {
					text: args.text,
					images,
					quote: args.quote !== false && state.sourceMessageId !== void 0
				};
				return "Final OneBot reply queued; a later onebot_reply call in this turn replaces it.";
			}
		});
	}
	async run(entry, event, text, imageSources) {
		const { agent } = entry.handle;
		await agent.whenIdle();
		if (this.stopped) throw new Error("onebot: client is stopped");
		const content = [];
		if (text !== "") content.push({
			type: "text",
			text
		});
		content.push(...await saveIncomingImages(this.ctx, imageSources, this.source().requestTimeout));
		entry.reply.active = true;
		entry.reply.candidate = void 0;
		entry.reply.sourceMessageId = event.message_id;
		try {
			agent.followup(createUserMessage({
				content,
				source: {
					kind: "onebot",
					form: "notice",
					summary: `OneBot ${event.message_type} message from ${String(event.user_id)}`
				}
			}));
			await agent.whenIdle();
		} finally {
			entry.reply.active = false;
			entry.reply.sourceMessageId = void 0;
		}
		const reply = entry.reply.candidate;
		entry.reply.candidate = void 0;
		if (reply === void 0 || this.stopped) return;
		const segments = [];
		if (reply.quote && event.message_id !== void 0) segments.push({
			type: "reply",
			data: { id: String(event.message_id) }
		});
		if (reply.text !== void 0 && reply.text !== "") segments.push({
			type: "text",
			data: { text: reply.text }
		});
		for (const image of reply.images) segments.push({
			type: "image",
			data: { file: image }
		});
		const action = event.message_type === "private" ? "send_private_msg" : "send_group_msg";
		const target = event.message_type === "private" ? { user_id: event.user_id } : { group_id: event.group_id };
		replyMessageId(await this.transport.request(action, {
			...target,
			message: segments
		}));
	}
};

//#endregion
//#region src/index.ts
const name = "onebot";
const inject = [
	"agentDefaultModel",
	"agents",
	"attachments",
	"systemPrompt",
	"tools",
	"webServer"
];
function apply(ctx, config) {
	const client = new OneBotClient(ctx, () => config.get());
	ctx.on("loader/volatile-update", () => client.restart());
	ctx.inject(["settings"], (sctx) => sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber)));
	registerOneBotConfigGateway(ctx, { source: () => config.get() });
	ctx.effect(() => {
		client.start();
		return () => client.stop();
	}, "onebot: WebSocket client");
}

//#endregion
export { Config, apply, inject, name, registerOneBotConfigGateway };