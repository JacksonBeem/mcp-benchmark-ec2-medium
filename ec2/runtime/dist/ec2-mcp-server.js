import Fastify from "fastify";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { freemem, loadavg, totalmem } from "node:os";
import { StdioBridge } from "./stdio-bridge.js";
const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const TOOL_NAME_SEPARATOR = "__";
const INSTANCE_ID = randomUUID().slice(0, 8);
const bridges = new Map();
function normalizeRouteKey(routeKey) {
    const normalized = String(routeKey ?? "").trim().replace(/^\/+|\/+$/g, "");
    if (!normalized || normalized === "shared" || normalized === "root") {
        return "shared";
    }
    return normalized;
}
function parseLegacyServerConfigs(raw) {
    return raw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map((entry) => {
        const separatorIndex = entry.indexOf(":");
        if (separatorIndex < 1) {
            throw new Error(`Invalid MCP_SERVERS entry: "${entry}"`);
        }
        return {
            name: entry.slice(0, separatorIndex).trim(),
            command: entry.slice(separatorIndex + 1).trim(),
        };
    });
}
function loadJsonFile(pathValue) {
    const resolved = resolve(process.cwd(), pathValue);
    if (!existsSync(resolved)) {
        throw new Error(`Missing JSON config file: ${resolved}`);
    }
    return JSON.parse(readFileSync(resolved, "utf8"));
}
function parseRouteConfigs() {
    const routeConfigsFile = process.env.MCP_ROUTE_CONFIGS_FILE;
    if (routeConfigsFile && routeConfigsFile.trim().length > 0) {
        const parsed = loadJsonFile(routeConfigsFile.trim());
        const routeConfigs = {};
        for (const [rawRouteKey, rawValue] of Object.entries(parsed)) {
            if (!Array.isArray(rawValue)) {
                continue;
            }
            const routeKey = normalizeRouteKey(rawRouteKey);
            routeConfigs[routeKey] = rawValue
                .filter((item) => typeof item === "object" && item !== null)
                .map((item) => ({
                name: String(item.name ?? "").trim(),
                command: String(item.command ?? "").trim(),
            }))
                .filter((item) => item.name.length > 0 && item.command.length > 0);
        }
        if (Object.keys(routeConfigs).length > 0) {
            return routeConfigs;
        }
    }
    const rawConfigs = process.env.MCP_ROUTE_CONFIGS;
    if (rawConfigs && rawConfigs.trim().length > 0) {
        const parsed = JSON.parse(rawConfigs);
        const routeConfigs = {};
        for (const [rawRouteKey, rawValue] of Object.entries(parsed)) {
            if (!Array.isArray(rawValue)) {
                continue;
            }
            const routeKey = normalizeRouteKey(rawRouteKey);
            routeConfigs[routeKey] = rawValue
                .filter((item) => typeof item === "object" && item !== null)
                .map((item) => ({
                name: String(item.name ?? "").trim(),
                command: String(item.command ?? "").trim(),
            }))
                .filter((item) => item.name.length > 0 && item.command.length > 0);
        }
        if (Object.keys(routeConfigs).length > 0) {
            return routeConfigs;
        }
    }
    const legacyConfigs = process.env.MCP_SERVER_CONFIGS;
    if (legacyConfigs && legacyConfigs.trim().length > 0) {
        return { shared: parseLegacyServerConfigs(legacyConfigs) };
    }
    throw new Error("No MCP route configuration found in MCP_ROUTE_CONFIGS_FILE, MCP_ROUTE_CONFIGS, or MCP_SERVER_CONFIGS");
}
const routeConfigs = parseRouteConfigs();
const allServerConfigs = Array.from(new Map(Object.values(routeConfigs)
    .flat()
    .map((config) => [config.name, config])).values());
function splitCommand(command) {
    const parts = command.split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
        throw new Error(`Invalid server command: "${command}"`);
    }
    const [cmd, ...args] = parts;
    return { cmd, args };
}
function getRouteServerConfigs(routeKey) {
    return routeConfigs[normalizeRouteKey(routeKey)] ?? [];
}
function bytesToMb(bytes) {
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
        return null;
    }
    return Math.round((bytes / 1024 / 1024) * 100) / 100;
}
function readLinuxRssBytes(pid) {
    if (!pid) {
        return null;
    }
    try {
        const status = readFileSync(`/proc/${pid}/status`, "utf8");
        const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
        return match ? Number.parseInt(match[1], 10) * 1024 : null;
    }
    catch {
        return null;
    }
}
function routeKeysForServer(serverName) {
    return Object.entries(routeConfigs)
        .filter(([, configs]) => configs.some((config) => config.name === serverName))
        .map(([routeKey]) => routeKey)
        .sort();
}
function getBridge(serverName) {
    const existing = bridges.get(serverName);
    if (existing) {
        return existing;
    }
    const config = allServerConfigs.find((item) => item.name === serverName);
    if (!config) {
        throw new Error(`Unknown server: ${serverName}`);
    }
    const { cmd, args } = splitCommand(config.command);
    const bridge = new StdioBridge(cmd, args);
    bridges.set(serverName, bridge);
    return bridge;
}
function withDurationHeaders(startMs, baseHeaders = {}) {
    return {
        ...baseHeaders,
        "X-Duration-Ms": (performance.now() - startMs).toFixed(2),
    };
}
function jsonRpcResult(id, result) {
    return { jsonrpc: "2.0", id, result };
}
function jsonRpcError(id, code, message, data) {
    const errorBody = { code, message };
    if (data) {
        errorBody.data = data;
    }
    return { jsonrpc: "2.0", id, error: errorBody };
}
async function collectToolDefinitions(routeKey) {
    const tools = [];
    for (const config of getRouteServerConfigs(routeKey)) {
        const bridge = getBridge(config.name);
        const names = await bridge.listTools();
        for (const toolName of names) {
            tools.push({
                name: `${config.name}${TOOL_NAME_SEPARATOR}${toolName}`,
                description: `Tool ${toolName} from ${config.name}`,
                inputSchema: {
                    type: "object",
                    additionalProperties: true,
                },
                annotations: {
                    legacy_name: `${config.name}/${toolName}`,
                },
            });
        }
    }
    return tools;
}
async function resolveToolCall(routeKey, toolName) {
    const routeServerNames = new Set(getRouteServerConfigs(routeKey).map((config) => config.name));
    if (toolName.includes(TOOL_NAME_SEPARATOR)) {
        const [serverName, bareToolName] = toolName.split(TOOL_NAME_SEPARATOR, 2);
        if (!serverName || !bareToolName) {
            throw new Error(`Invalid tool name "${toolName}". Expected "server${TOOL_NAME_SEPARATOR}tool".`);
        }
        if (!routeServerNames.has(serverName)) {
            throw new Error(`Tool "${toolName}" is not available on route "${normalizeRouteKey(routeKey)}".`);
        }
        return { serverName, bareToolName };
    }
    if (toolName.includes("/")) {
        const [serverName, bareToolName] = toolName.split("/", 2);
        if (!serverName || !bareToolName) {
            throw new Error(`Invalid tool name "${toolName}". Expected "server/tool".`);
        }
        if (!routeServerNames.has(serverName)) {
            throw new Error(`Tool "${toolName}" is not available on route "${normalizeRouteKey(routeKey)}".`);
        }
        return { serverName, bareToolName };
    }
    const matches = [];
    for (const config of getRouteServerConfigs(routeKey)) {
        const bridge = getBridge(config.name);
        const names = await bridge.listTools();
        if (names.includes(toolName)) {
            matches.push({ serverName: config.name, bareToolName: toolName });
        }
    }
    if (matches.length === 0) {
        throw new Error(`Unknown tool "${toolName}"`);
    }
    if (matches.length > 1) {
        throw new Error(`Ambiguous tool "${toolName}". Use "server${TOOL_NAME_SEPARATOR}tool" format.`);
    }
    return matches[0];
}
function parseJsonRpcBody(body) {
    if (typeof body === "string") {
        return JSON.parse(body);
    }
    if (typeof body === "object" && body !== null) {
        return body;
    }
    return {};
}
const fastify = Fastify({ logger: false });
async function handleMcp(request, reply, routeKey) {
    const startMs = performance.now();
    const normalizedRouteKey = normalizeRouteKey(routeKey);
    const routeServers = getRouteServerConfigs(normalizedRouteKey);
    const sessionId = String(randomUUID());
    const baseHeaders = { "Mcp-Session-Id": sessionId };
    if (routeServers.length === 0) {
        return reply.code(404).headers(withDurationHeaders(startMs, baseHeaders)).send({
            error: `Unknown route "${normalizedRouteKey}"`,
        });
    }
    if (request.method === "HEAD") {
        return reply
            .code(200)
            .headers(withDurationHeaders(startMs, { ...baseHeaders, "X-MCP-Transport": "streamable-http" }))
            .send();
    }
    let body;
    try {
        body = parseJsonRpcBody(request.body);
    }
    catch {
        return reply.code(400).headers(withDurationHeaders(startMs, baseHeaders)).send(jsonRpcError(null, -32700, "Parse error"));
    }
    const method = String(body.method ?? "");
    const id = body.id ?? null;
    try {
        if (method === "initialize") {
            return reply.code(200).headers(withDurationHeaders(startMs, baseHeaders)).send(jsonRpcResult(id, {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: {
                    name: "mcp-benchmark-light-runtime",
                    version: "0.1.0",
                    instance: INSTANCE_ID,
                },
            }));
        }
        if (method === "notifications/initialized") {
            return reply.code(202).headers(withDurationHeaders(startMs, baseHeaders)).send();
        }
        if (method === "tools/list") {
            const tools = await collectToolDefinitions(normalizedRouteKey);
            return reply.code(200).headers(withDurationHeaders(startMs, baseHeaders)).send(jsonRpcResult(id, { tools }));
        }
        if (method !== "tools/call") {
            return reply.code(400).headers(withDurationHeaders(startMs, baseHeaders)).send(jsonRpcError(id, -32601, `Unsupported method: ${method}`));
        }
        const params = body.params ?? {};
        const requestedToolName = String(params.name ?? "");
        if (!requestedToolName) {
            return reply.code(400).headers(withDurationHeaders(startMs, baseHeaders)).send(jsonRpcError(id, -32602, "Missing params.name"));
        }
        const callArguments = typeof params.arguments === "object" && params.arguments !== null
            ? params.arguments
            : {};
        const { serverName, bareToolName } = await resolveToolCall(normalizedRouteKey, requestedToolName);
        const bridge = getBridge(serverName);
        const result = await bridge.callTool(bareToolName, callArguments);
        if (result.error) {
            return reply.code(500).headers(withDurationHeaders(startMs, baseHeaders)).send(jsonRpcError(id, result.error.code, result.error.message, { serverName, toolName: bareToolName }));
        }
        return reply.code(200).headers(withDurationHeaders(startMs, baseHeaders)).send({
            jsonrpc: "2.0",
            id,
            result: result.result ?? {},
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.code(500).headers(withDurationHeaders(startMs, baseHeaders)).send(jsonRpcError(id, -32603, message));
    }
}
fastify.get("/health", async () => ({
    status: "ok",
    route: "shared",
    server_count: getRouteServerConfigs("shared").length,
}));
fastify.get("/:route/health", async (request, reply) => {
    const route = normalizeRouteKey(request.params.route);
    const configs = getRouteServerConfigs(route);
    if (configs.length === 0) {
        return reply.code(404).send({ status: "error", message: `Unknown route "${route}"` });
    }
    return {
        status: "ok",
        route,
        server_count: configs.length,
        servers: configs.map((item) => item.name),
    };
});
fastify.get("/metrics", async (_request, reply) => {
    const runtimeMemory = process.memoryUsage();
    const serverProcesses = allServerConfigs.map((config) => {
        const bridge = bridges.get(config.name);
        const processInfo = bridge?.getProcessInfo();
        const rssBytes = readLinuxRssBytes(processInfo?.pid ?? null);
        return {
            name: config.name,
            route_keys: routeKeysForServer(config.name),
            command: config.command,
            pid: processInfo?.pid ?? null,
            alive: processInfo?.alive ?? false,
            rss_bytes: rssBytes,
            rss_mb: bytesToMb(rssBytes),
        };
    });
    const totalChildRssBytes = serverProcesses.reduce((total, item) => total + (typeof item.rss_bytes === "number" ? item.rss_bytes : 0), 0);
    const systemTotalBytes = totalmem();
    const systemFreeBytes = freemem();
    const systemUsedBytes = systemTotalBytes - systemFreeBytes;
    return reply.header("Cache-Control", "no-store").send({
        status: "ok",
        instance: INSTANCE_ID,
        timestamp: new Date().toISOString(),
        runtime: {
            pid: process.pid,
            rss_bytes: runtimeMemory.rss,
            rss_mb: bytesToMb(runtimeMemory.rss),
            heap_total_bytes: runtimeMemory.heapTotal,
            heap_total_mb: bytesToMb(runtimeMemory.heapTotal),
            heap_used_bytes: runtimeMemory.heapUsed,
            heap_used_mb: bytesToMb(runtimeMemory.heapUsed),
            external_bytes: runtimeMemory.external,
            external_mb: bytesToMb(runtimeMemory.external),
            array_buffers_bytes: runtimeMemory.arrayBuffers,
            array_buffers_mb: bytesToMb(runtimeMemory.arrayBuffers),
        },
        child_processes: {
            count: serverProcesses.length,
            alive_count: serverProcesses.filter((item) => item.alive).length,
            total_rss_bytes: totalChildRssBytes,
            total_rss_mb: bytesToMb(totalChildRssBytes),
            servers: serverProcesses,
        },
        system: {
            total_bytes: systemTotalBytes,
            total_mb: bytesToMb(systemTotalBytes),
            free_bytes: systemFreeBytes,
            free_mb: bytesToMb(systemFreeBytes),
            used_bytes: systemUsedBytes,
            used_mb: bytesToMb(systemUsedBytes),
            loadavg: loadavg(),
        },
    });
});
fastify.head("/mcp", async (request, reply) => handleMcp({ method: "HEAD", body: null, url: "/mcp" }, reply, "shared"));
fastify.post("/mcp", async (request, reply) => handleMcp({ method: "POST", body: request.body, url: "/mcp" }, reply, "shared"));
fastify.head("/:route/mcp", async (request, reply) => handleMcp({ method: "HEAD", body: null, url: request.url }, reply, request.params.route));
fastify.post("/:route/mcp", async (request, reply) => handleMcp({ method: "POST", body: request.body, url: request.url }, reply, request.params.route));
await fastify.listen({ host: "0.0.0.0", port: PORT });
