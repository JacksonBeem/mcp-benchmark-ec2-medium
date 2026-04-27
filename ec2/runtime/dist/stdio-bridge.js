import { spawn } from "child_process";
import { randomUUID } from "crypto";
export class StdioBridge {
    command;
    args;
    requestTimeoutMs;
    spawnTimeoutMs;
    child = null;
    buffer = "";
    pending = new Map();
    toolCache = [];
    initialized = false;
    initPromise = null;
    serialQueue = Promise.resolve();
    constructor(command, args, requestTimeoutMs = 20_000, spawnTimeoutMs = 10_000) {
        this.command = command;
        this.args = args;
        this.requestTimeoutMs = requestTimeoutMs;
        this.spawnTimeoutMs = spawnTimeoutMs;
    }
    async ensureReady() {
        await this.enqueue(async () => {
            await this.ensureReadyInternal();
        });
    }
    async callTool(toolName, args) {
        return this.enqueue(async () => {
            await this.ensureReadyInternal();
            if (!this.toolCache.includes(toolName)) {
                throw new Error(`Tool "${toolName}" not found. Available: ${this.toolCache.join(", ")}`);
            }
            return this.sendRequest("tools/call", { name: toolName, arguments: args });
        });
    }
    async listTools() {
        return this.enqueue(async () => {
            await this.ensureReadyInternal();
            return [...this.toolCache];
        });
    }
    kill() {
        this.invalidateBridge(new Error("Bridge killed"));
        this.initPromise = null;
    }
    getProcessInfo() {
        return {
            command: this.command,
            args: [...this.args],
            pid: this.child?.pid ?? null,
            alive: this.isChildAlive(),
        };
    }
    enqueue(fn) {
        const next = this.serialQueue.then(fn, fn);
        this.serialQueue = next.then(() => undefined, () => undefined);
        return next;
    }
    async ensureReadyInternal() {
        if (this.initialized && this.child && this.isChildAlive()) {
            return;
        }
        if (!this.initPromise) {
            this.initPromise = this.spawnAndInitialize().finally(() => {
                this.initPromise = null;
            });
        }
        await this.initPromise;
    }
    async spawnAndInitialize() {
        this.invalidateBridge(new Error("Bridge reinitializing"));
        const spawnedChild = spawn(this.command, this.args, {
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env },
        });
        this.child = spawnedChild;
        spawnedChild.stdout?.on("data", (chunk) => {
            if (this.child !== spawnedChild) {
                return;
            }
            this.buffer += chunk.toString();
            this.processBuffer();
        });
        spawnedChild.stderr?.on("data", (chunk) => {
            if (this.child !== spawnedChild) {
                return;
            }
            console.error(`[mcp-stderr] ${chunk.toString().trim()}`);
        });
        spawnedChild.on("error", (error) => {
            if (this.child !== spawnedChild) {
                return;
            }
            this.invalidateBridge(new Error(`MCP child process error: ${error.message}`), spawnedChild);
        });
        spawnedChild.on("exit", (code, signal) => {
            if (this.child !== spawnedChild) {
                return;
            }
            const reason = signal ? `signal ${signal}` : `code ${code}`;
            this.invalidateBridge(new Error(`MCP server exited with ${reason}`), spawnedChild, false);
        });
        await this.sendRequest("initialize", {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "mcp-benchmark-light-runtime", version: "1.0.0" },
        }, this.spawnTimeoutMs);
        this.sendNotification("notifications/initialized", {});
        const toolsResp = await this.sendRequest("tools/list", {}, this.spawnTimeoutMs);
        const rawTools = toolsResp.result?.tools;
        if (Array.isArray(rawTools)) {
            this.toolCache = rawTools
                .map((tool) => (typeof tool === "object" && tool ? tool.name : undefined))
                .filter((name) => typeof name === "string");
        }
        else {
            this.toolCache = [];
        }
        this.initialized = true;
    }
    sendNotification(method, params) {
        if (!this.child || !this.isChildAlive() || !this.child.stdin || this.child.stdin.destroyed) {
            throw new Error("Child process not running");
        }
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`, (error) => {
            if (!error) {
                return;
            }
            this.invalidateBridge(new Error(`Failed to write MCP notification "${method}": ${error.message}`));
        });
    }
    sendRequest(method, params, timeoutMs) {
        return new Promise((resolve, reject) => {
            if (!this.child || !this.isChildAlive() || !this.child.stdin || this.child.stdin.destroyed) {
                reject(new Error("Child process not running"));
                return;
            }
            const id = randomUUID();
            const timeout = timeoutMs ?? this.requestTimeoutMs;
            const activeChild = this.child;
            const timer = setTimeout(() => {
                const timeoutError = new Error(`MCP "${method}" timed out after ${timeout}ms`);
                const pending = this.pending.get(id);
                if (!pending) {
                    return;
                }
                this.pending.delete(id);
                pending.reject(timeoutError);
                this.invalidateBridge(timeoutError, activeChild);
            }, timeout);
            this.pending.set(id, { resolve, reject, timer });
            const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
            this.child.stdin.write(`${payload}\n`, (error) => {
                if (!error) {
                    return;
                }
                clearTimeout(timer);
                this.pending.delete(id);
                const writeError = new Error(`Failed to write MCP "${method}" request: ${error.message}`);
                reject(writeError);
                this.invalidateBridge(writeError, activeChild);
            });
        });
    }
    processBuffer() {
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() ?? "";
        for (const line of lines) {
            if (!line.trim()) {
                continue;
            }
            try {
                const message = JSON.parse(line);
                if (typeof message.id === "string" && this.pending.has(message.id)) {
                    const pending = this.pending.get(message.id);
                    if (!pending) {
                        continue;
                    }
                    clearTimeout(pending.timer);
                    this.pending.delete(message.id);
                    pending.resolve(message);
                }
            }
            catch {
                this.invalidateBridge(new Error("Failed to parse JSON from MCP server stdout"));
            }
        }
    }
    isChildAlive() {
        return this.child !== null && this.child.exitCode === null && !this.child.killed;
    }
    invalidateBridge(error, child = this.child, terminateChild = true) {
        this.initialized = false;
        this.buffer = "";
        this.toolCache = [];
        if (this.child === child) {
            this.child = null;
        }
        this.rejectPending(error);
        if (!terminateChild || !child || child.exitCode !== null || child.killed) {
            return;
        }
        child.kill("SIGTERM");
        setTimeout(() => {
            if (child.exitCode === null && !child.killed) {
                child.kill("SIGKILL");
            }
        }, 3_000);
    }
    rejectPending(error) {
        for (const [, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }
}
