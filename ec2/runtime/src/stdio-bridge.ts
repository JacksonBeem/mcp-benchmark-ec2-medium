import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";

interface PendingRequest {
  resolve: (response: McpResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface McpResponse {
  jsonrpc: "2.0";
  id: string;
  result?: {
    content?: Array<{ type: string; text?: string }>;
    [key: string]: unknown;
  };
  error?: { code: number; message: string };
}

export interface BridgeProcessInfo {
  command: string;
  args: string[];
  pid: number | null;
  alive: boolean;
}

export class StdioBridge {
  private child: ChildProcess | null = null;
  private buffer = "";
  private pending = new Map<string, PendingRequest>();
  private toolCache: string[] = [];
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private serialQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private command: string,
    private args: string[],
    private requestTimeoutMs = 20_000,
    private spawnTimeoutMs = 10_000,
  ) {}

  async ensureReady(): Promise<void> {
    await this.enqueue(async () => {
      await this.ensureReadyInternal();
    });
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<McpResponse> {
    return this.enqueue(async () => {
      await this.ensureReadyInternal();
      if (!this.toolCache.includes(toolName)) {
        throw new Error(`Tool "${toolName}" not found. Available: ${this.toolCache.join(", ")}`);
      }
      return this.sendRequest("tools/call", { name: toolName, arguments: args });
    });
  }

  async listTools(): Promise<string[]> {
    return this.enqueue(async () => {
      await this.ensureReadyInternal();
      return [...this.toolCache];
    });
  }

  kill(): void {
    this.invalidateBridge(new Error("Bridge killed"));
    this.initPromise = null;
  }

  getProcessInfo(): BridgeProcessInfo {
    return {
      command: this.command,
      args: [...this.args],
      pid: this.child?.pid ?? null,
      alive: this.isChildAlive(),
    };
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.serialQueue.then(fn, fn);
    this.serialQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async ensureReadyInternal(): Promise<void> {
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

  private async spawnAndInitialize(): Promise<void> {
    this.invalidateBridge(new Error("Bridge reinitializing"));

    const spawnedChild = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    this.child = spawnedChild;

    spawnedChild.stdout?.on("data", (chunk: Buffer) => {
      if (this.child !== spawnedChild) {
        return;
      }
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    spawnedChild.stderr?.on("data", (chunk: Buffer) => {
      if (this.child !== spawnedChild) {
        return;
      }
      console.error(`[mcp-stderr] ${chunk.toString().trim()}`);
    });

    spawnedChild.on("error", (error: Error) => {
      if (this.child !== spawnedChild) {
        return;
      }
      this.invalidateBridge(new Error(`MCP child process error: ${error.message}`), spawnedChild);
    });

    spawnedChild.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.child !== spawnedChild) {
        return;
      }
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      this.invalidateBridge(new Error(`MCP server exited with ${reason}`), spawnedChild, false);
    });

    await this.sendRequest(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "mcp-benchmark-light-runtime", version: "1.0.0" },
      },
      this.spawnTimeoutMs,
    );

    this.sendNotification("notifications/initialized", {});

    const toolsResp = await this.sendRequest("tools/list", {}, this.spawnTimeoutMs);
    const rawTools = toolsResp.result?.tools;
    if (Array.isArray(rawTools)) {
      this.toolCache = rawTools
        .map((tool) => (typeof tool === "object" && tool ? (tool as { name?: unknown }).name : undefined))
        .filter((name): name is string => typeof name === "string");
    } else {
      this.toolCache = [];
    }

    this.initialized = true;
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    if (!this.child || !this.isChildAlive() || !this.child.stdin || this.child.stdin.destroyed) {
      throw new Error("Child process not running");
    }

    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
      (error?: Error | null) => {
        if (!error) {
          return;
        }
        this.invalidateBridge(new Error(`Failed to write MCP notification "${method}": ${error.message}`));
      },
    );
  }

  private sendRequest(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<McpResponse> {
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
      this.child.stdin.write(`${payload}\n`, (error?: Error | null) => {
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

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      try {
        const message = JSON.parse(line) as { id?: unknown };
        if (typeof message.id === "string" && this.pending.has(message.id)) {
          const pending = this.pending.get(message.id);
          if (!pending) {
            continue;
          }
          clearTimeout(pending.timer);
          this.pending.delete(message.id);
          pending.resolve(message as McpResponse);
        }
      } catch {
        this.invalidateBridge(new Error("Failed to parse JSON from MCP server stdout"));
      }
    }
  }

  private isChildAlive(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed;
  }

  private invalidateBridge(
    error: Error,
    child: ChildProcess | null = this.child,
    terminateChild = true,
  ): void {
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

  private rejectPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
