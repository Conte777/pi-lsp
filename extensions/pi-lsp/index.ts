import fs from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { MessageConnection } from "vscode-jsonrpc";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import {
  DefinitionRequest,
  DidChangeConfigurationNotification,
  DidChangeTextDocumentNotification,
  DidOpenTextDocumentNotification,
  DidSaveTextDocumentNotification,
  DocumentSymbolRequest,
  HoverRequest,
  InitializeRequest,
  InitializedNotification,
  PublishDiagnosticsNotification,
  ReferencesRequest,
  type Diagnostic,
  type InitializeResult,
  type ServerCapabilities,
} from "vscode-languageserver-protocol";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Spacer, Text } from "@earendil-works/pi-tui";
import { loadLspConfig } from "../_shared/config";
import { isPathIncluded, matchesAnyGlob } from "../_shared/glob";
import { filePathToUri, findProjectRoot, normalizeRelativePath, resolveCommand, toAbsolutePath, uriToFilePath } from "../_shared/paths";
import { formatLspDiagnostics, formatWarnings, hasIssueOutput, joinSections } from "../_shared/output";
import { isExecutableAvailable } from "../_shared/runner";
import type { LspServerConfig, StoredDiagnostics } from "../_shared/types";

const DEFAULT_STARTUP_TIMEOUT_MS = 45_000;
const DEFAULT_DIAGNOSTICS_WAIT_MS = 1_500;
const DEFAULT_MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const SHUTDOWN_WRITE_TIMEOUT_MS = 100;

interface MatchedServer {
  server: LspServerConfig;
  root: string;
}

type NavigationRequest =
  | { kind: "hover" | "definition"; line: number; character: number }
  | { kind: "references"; line: number; character: number; includeDeclaration: boolean }
  | { kind: "symbols" };

interface OpenDocument {
  file: string;
  uri: string;
  languageId: string;
  version: number;
  text: string;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new Error("aborted"));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timeout);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function canWriteToChild(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode === null && child.signalCode === null && child.stdin.writable && !child.stdin.destroyed && !child.stdin.writableEnded;
}

async function bestEffortWriteJsonRpc(child: ChildProcessWithoutNullStreams, message: Record<string, unknown>): Promise<void> {
  if (!canWriteToChild(child)) return;

  const json = JSON.stringify(message);
  const payload = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(finish, SHUTDOWN_WRITE_TIMEOUT_MS);
    timeout.unref();

    try {
      child.stdin.write(payload, "utf8", finish);
    } catch {
      finish();
    }
  });
}

function getEventPath(input: Record<string, unknown>): string | undefined {
  return typeof input.path === "string" && input.path.trim() ? input.path : undefined;
}

async function readTextFile(file: string): Promise<string> {
  return fs.readFile(file, "utf8");
}

async function fileSizeAllowed(file: string, limit: number): Promise<boolean> {
  const stat = await fs.stat(file);
  return stat.size <= limit;
}

function languageIdForFile(server: LspServerConfig, file: string): string {
  const extension = path.extname(file);
  return server.languageIdByExtension?.[extension] ?? (extension.replace(/^\./, "") || "plaintext");
}

function couldMatchBeforeRoot(file: string, cwd: string, include?: string[], exclude?: string[]): boolean {
  const candidates = [...new Set([normalizeRelativePath(path.relative(cwd, file)), path.basename(file)])];
  const included = !include || include.length === 0 || candidates.some((candidate) => matchesAnyGlob(include, candidate));
  if (!included) return false;
  return !candidates.some((candidate) => matchesAnyGlob(exclude, candidate));
}

function supportsSave(capabilities: ServerCapabilities | undefined): boolean {
  const sync = capabilities?.textDocumentSync;
  if (!sync || typeof sync === "number") return false;
  return !!sync.save;
}

function clientKey(serverId: string, root: string): string {
  return `${serverId}\u0000${root}`;
}

function formatUnknownResult(value: unknown): string {
  if (value === null || value === undefined) return "No result";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function textToolResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function customMessageText(content: unknown, details: unknown): string {
  const summary = (details as { summary?: unknown } | undefined)?.summary;
  if (typeof summary === "string") return summary;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type: string; text: string } => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function registerDiagnosticsRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer("pi-lsp-diagnostics", (message, _options, theme) => {
    const text = customMessageText(message.content, message.details);
    const box = new Box(1, 1, (value) => theme.bg("toolSuccessBg", value));
    box.addChild(new Text(theme.fg("toolTitle", theme.bold("lsp_diagnostics")), 0, 0));
    if (text.trim()) {
      box.addChild(new Spacer(1));
      box.addChild(new Text(theme.fg("toolOutput", text), 0, 0));
    }
    return box;
  });
}

class DiagnosticsStore {
  private readonly diagnostics = new Map<string, StoredDiagnostics>();

  private key(serverId: string, root: string, file: string): string {
    return `${serverId}\u0000${root}\u0000${file}`;
  }

  set(serverId: string, root: string, uri: string, diagnostics: Diagnostic[], version?: number): void {
    const file = uriToFilePath(uri);
    const key = this.key(serverId, root, file);
    if (diagnostics.length === 0) {
      this.diagnostics.delete(key);
      return;
    }
    this.diagnostics.set(key, {
      serverId,
      root,
      file,
      version,
      diagnostics,
      updatedAt: Date.now(),
    });
  }

  get(serverId: string, root: string, file: string): StoredDiagnostics | undefined {
    return this.diagnostics.get(this.key(serverId, root, file));
  }

  clear(serverId: string, root: string): void {
    for (const [key, entry] of this.diagnostics) {
      if (entry.serverId === serverId && entry.root === root) this.diagnostics.delete(key);
    }
  }

  getAllForFile(file: string): StoredDiagnostics[] {
    return [...this.diagnostics.values()].filter((entry) => entry.file === file);
  }
}

class LspClient {
  private process: ChildProcessWithoutNullStreams | undefined;
  private connection: MessageConnection | undefined;
  private capabilities: ServerCapabilities | undefined;
  private readonly documents = new Map<string, OpenDocument>();
  private startPromise: Promise<void> | undefined;
  private failure: { retryAt: number; attempts: number; reason: string } | undefined;
  private stopped = false;
  private stderrTail = "";

  constructor(
    private server: LspServerConfig,
    private readonly root: string,
    private readonly diagnostics: DiagnosticsStore,
  ) {}

  private async ensureStarted(server: LspServerConfig, workspace: string, file: string, signal?: AbortSignal): Promise<void> {
    if (this.stopped) throw new Error(`${this.server.id}: LSP client stopped`);
    if (this.failure && Date.now() < this.failure.retryAt) {
      throw new Error(`${this.server.id}: unavailable (${this.failure.reason}); retry after ${new Date(this.failure.retryAt).toISOString()}`);
    }
    this.startPromise ??= this.start(server, workspace, file, signal).then(() => {
      this.failure = undefined;
    }).catch(async (error: Error) => {
      const attempts = (this.failure?.attempts ?? 0) + 1;
      const reason = [error.message, this.stderrTail.trim()].filter(Boolean).join(": ");
      await this.stopProcess();
      const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(attempts, 6));
      this.failure = { attempts, retryAt: Date.now() + delayMs, reason };
      this.startPromise = undefined;
      throw new Error(reason);
    });
    await this.startPromise;
  }

  private async start(server: LspServerConfig, workspace: string, file: string, signal?: AbortSignal): Promise<void> {
    this.server = server;
    this.stderrTail = "";
    const command = resolveCommand(server.id, server, { workspace, root: this.root, file });
    if (!isExecutableAvailable(command.bin)) {
      throw new Error(`${server.id}: LSP binary not found: ${command.bin}`);
    }

    const child = spawn(command.bin, command.args, {
      cwd: command.cwd,
      env: command.env ? { ...process.env, ...command.env } : process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process = child;
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString()}`.slice(-4000);
    });
    const connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
    this.connection = connection;
    child.on("error", (error) => {
      this.stderrTail = `${this.stderrTail}${error.message}`.slice(-4000);
      connection.dispose();
    });
    child.on("exit", () => {
      connection.dispose();
      if (this.process !== child) return;
      this.process = undefined;
      this.connection = undefined;
      this.startPromise = undefined;
      this.documents.clear();
      this.diagnostics.clear(this.server.id, this.root);
    });

    this.registerHandlers(connection);
    connection.listen();

    const initializeResult = (await withTimeout(
      connection.sendRequest(InitializeRequest.method, this.initializeParams()),
      this.server.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      `${this.server.id} initialize`,
    )) as InitializeResult;
    this.capabilities = initializeResult.capabilities;

    await connection.sendNotification(InitializedNotification.method, {});
    if (this.server.settings !== undefined) {
      await connection.sendNotification(DidChangeConfigurationNotification.method, { settings: this.server.settings });
    }

    if (signal?.aborted) throw new Error("aborted");
  }

  private initializeParams() {
    const rootUri = filePathToUri(this.root);
    return {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ name: path.basename(this.root), uri: rootUri }],
      capabilities: {
        window: { workDoneProgress: true },
        workspace: {
          configuration: true,
          workspaceFolders: true,
          didChangeWatchedFiles: { dynamicRegistration: true },
        },
        textDocument: {
          synchronization: {
            didOpen: true,
            didChange: true,
            didSave: true,
          },
          publishDiagnostics: {
            relatedInformation: true,
            versionSupport: true,
          },
          hover: {},
          definition: {},
          references: {},
          documentSymbol: {},
        },
      },
      initializationOptions: this.server.initializationOptions ?? {},
    };
  }

  private registerHandlers(connection: MessageConnection): void {
    connection.onNotification(
      PublishDiagnosticsNotification.method,
      (params: { uri: string; diagnostics: Diagnostic[]; version?: number }) => {
        this.diagnostics.set(this.server.id, this.root, params.uri, params.diagnostics, params.version);
      },
    );

    const anyConnection = connection as unknown as {
      onRequest(method: string, handler: (params: unknown) => unknown): void;
      onNotification(method: string, handler: (params: unknown) => void): void;
    };

    anyConnection.onRequest("workspace/configuration", (params: unknown) => {
      const items = (params as { items?: unknown[] } | undefined)?.items;
      if (!Array.isArray(items)) return [this.server.settings ?? {}];
      return items.map(() => this.server.settings ?? {});
    });
    anyConnection.onRequest("workspace/workspaceFolders", () => [{ name: path.basename(this.root), uri: filePathToUri(this.root) }]);
    anyConnection.onRequest("client/registerCapability", () => null);
    anyConnection.onRequest("client/unregisterCapability", () => null);
    anyConnection.onRequest("window/workDoneProgress/create", () => null);
    anyConnection.onNotification("window/logMessage", () => undefined);
    anyConnection.onNotification("telemetry/event", () => undefined);
  }

  private async openOrChange(file: string, languageId: string, text: string): Promise<OpenDocument> {
    if (!this.connection) throw new Error(`${this.server.id}: LSP connection unavailable`);

    const existing = this.documents.get(file);
    if (!existing) {
      const doc: OpenDocument = { file, uri: filePathToUri(file), languageId, version: 1, text };
      this.documents.set(file, doc);
      await this.connection.sendNotification(DidOpenTextDocumentNotification.method, {
        textDocument: {
          uri: doc.uri,
          languageId: doc.languageId,
          version: doc.version,
          text: doc.text,
        },
      });
      return doc;
    }

    const doc = { ...existing, version: existing.version + 1, text };
    this.documents.set(file, doc);
    await this.connection.sendNotification(DidChangeTextDocumentNotification.method, {
      textDocument: { uri: doc.uri, version: doc.version },
      contentChanges: [{ text: doc.text }],
    });
    return doc;
  }

  private async didSave(file: string): Promise<void> {
    if (!this.connection || !supportsSave(this.capabilities)) return;
    const doc = this.documents.get(file);
    if (!doc) return;
    await this.connection.sendNotification(DidSaveTextDocumentNotification.method, {
      textDocument: { uri: doc.uri },
      text: doc.text,
    });
  }

  private async hover(file: string, line: number, character: number): Promise<unknown> {
    if (!this.connection) throw new Error(`${this.server.id}: LSP connection unavailable`);
    return withTimeout(
      this.connection.sendRequest(HoverRequest.method, {
        textDocument: { uri: filePathToUri(file) },
        position: { line, character },
      }),
      REQUEST_TIMEOUT_MS,
      `${this.server.id} hover`,
    );
  }

  private async definition(file: string, line: number, character: number): Promise<unknown> {
    if (!this.connection) throw new Error(`${this.server.id}: LSP connection unavailable`);
    return withTimeout(
      this.connection.sendRequest(DefinitionRequest.method, {
        textDocument: { uri: filePathToUri(file) },
        position: { line, character },
      }),
      REQUEST_TIMEOUT_MS,
      `${this.server.id} definition`,
    );
  }

  private async references(file: string, line: number, character: number, includeDeclaration: boolean): Promise<unknown> {
    if (!this.connection) throw new Error(`${this.server.id}: LSP connection unavailable`);
    return withTimeout(
      this.connection.sendRequest(ReferencesRequest.method, {
        textDocument: { uri: filePathToUri(file) },
        position: { line, character },
        context: { includeDeclaration },
      }),
      REQUEST_TIMEOUT_MS,
      `${this.server.id} references`,
    );
  }

  private async symbols(file: string): Promise<unknown> {
    if (!this.connection) throw new Error(`${this.server.id}: LSP connection unavailable`);
    return withTimeout(
      this.connection.sendRequest(DocumentSymbolRequest.method, {
        textDocument: { uri: filePathToUri(file) },
      }),
      REQUEST_TIMEOUT_MS,
      `${this.server.id} document symbols`,
    );
  }

  private async prepareDocument(file: string, server: LspServerConfig, workspace: string, signal?: AbortSignal): Promise<void> {
    const limit = server.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
    if (!(await fileSizeAllowed(file, limit))) {
      throw new Error(`skipped ${normalizeRelativePath(path.relative(this.root, file))}; file exceeds maxFileSizeBytes (${limit})`);
    }
    const text = await readTextFile(file);
    await this.ensureStarted(server, workspace, file, signal);
    await this.openOrChange(file, languageIdForFile(server, file), text);
  }

  async updateDiagnostics(file: string, server: LspServerConfig, workspace: string, signal?: AbortSignal): Promise<string> {
    await this.prepareDocument(file, server, workspace, signal);
    await this.didSave(file);
    await delay(server.diagnosticsWaitMs ?? DEFAULT_DIAGNOSTICS_WAIT_MS, signal);
    const entry = this.diagnostics.get(this.server.id, this.root, file);
    return formatLspDiagnostics(this.server.id, file, entry?.diagnostics ?? [], this.root);
  }

  async navigate(file: string, server: LspServerConfig, workspace: string, request: NavigationRequest, signal?: AbortSignal): Promise<unknown> {
    await this.prepareDocument(file, server, workspace, signal);
    switch (request.kind) {
      case "hover": return this.hover(file, request.line, request.character);
      case "definition": return this.definition(file, request.line, request.character);
      case "references": return this.references(file, request.line, request.character, request.includeDeclaration);
      case "symbols": return this.symbols(file);
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    await this.stopProcess();
  }

  private async stopProcess(): Promise<void> {
    const connection = this.connection;
    const child = this.process;
    this.connection = undefined;
    this.process = undefined;
    this.documents.clear();
    this.diagnostics.clear(this.server.id, this.root);

    if (child) {
      await bestEffortWriteJsonRpc(child, { jsonrpc: "2.0", id: "pi-lsp-shutdown", method: "shutdown" });
      await bestEffortWriteJsonRpc(child, { jsonrpc: "2.0", method: "exit" });
    }

    connection?.dispose();

    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 2_000).unref();
    }
  }
}

class LspManager {
  private readonly diagnostics = new DiagnosticsStore();
  private readonly clients = new Map<string, LspClient>();

  async matchingServers(ctx: ExtensionContext, file: string): Promise<{ matches: MatchedServer[]; warnings: string[]; workspace: string }> {
    const loaded = await loadLspConfig(ctx);
    const warnings = [...loaded.warnings];
    const projectLayer = loaded.layers.find((layer) => layer.scope === "project");
    const workspace = projectLayer ? path.dirname(projectLayer.dir) : ctx.cwd;
    const matches: MatchedServer[] = [];

    for (const server of loaded.items) {
      if (server.enabled === false) continue;
      if (!couldMatchBeforeRoot(file, ctx.cwd, server.include, server.exclude)) continue;

      const root = findProjectRoot(file, server.rootMarkers, ctx.cwd);
      if (!root) {
        warnings.push(`${server.id}: root markers not found (${(server.rootMarkers ?? []).join(", ") || "none"})`);
        continue;
      }
      const relFile = normalizeRelativePath(path.relative(root, file));
      if (relFile.startsWith("..") || path.isAbsolute(relFile)) continue;
      if (!isPathIncluded(relFile, server.include, server.exclude)) continue;
      matches.push({ server, root });
    }

    return { matches, warnings, workspace };
  }

  private getClient(server: LspServerConfig, root: string): LspClient {
    const key = clientKey(server.id, root);
    let client = this.clients.get(key);
    if (!client) {
      client = new LspClient(server, root, this.diagnostics);
      this.clients.set(key, client);
    }
    return client;
  }

  async updateDiagnosticsForFile(ctx: ExtensionContext, file: string): Promise<string> {
    const { matches, warnings, workspace } = await this.matchingServers(ctx, file);
    if (matches.length === 0) return formatWarnings("LSP diagnostics", warnings);

    const lines: string[] = [];
    for (const match of matches) {
      try {
        const client = this.getClient(match.server, match.root);
        lines.push(await client.updateDiagnostics(file, match.server, workspace, ctx.signal));
      } catch (error) {
        lines.push(`⚠️ ${match.server.id}: ${(error as Error).message}`);
      }
    }

    return [formatWarnings("LSP diagnostics", warnings), joinSections("LSP diagnostics", lines)].filter(Boolean).join("\n\n");
  }

  async navigate(ctx: ExtensionContext, inputPath: string, request: NavigationRequest): Promise<string> {
    const file = toAbsolutePath(inputPath, ctx.cwd);
    const { matches, workspace } = await this.matchingServers(ctx, file);
    const match = matches[0];
    if (!match) return `No matching LSP server for ${inputPath}`;
    const client = this.getClient(match.server, match.root);
    return formatUnknownResult(await client.navigate(file, match.server, workspace, request, ctx.signal));
  }

  diagnosticsForPath(ctx: ExtensionContext, inputPath: string): string {
    const file = toAbsolutePath(inputPath, ctx.cwd);
    const entries = this.diagnostics.getAllForFile(file);
    if (entries.length === 0) return `LSP diagnostics:\n\n✅ no diagnostics recorded for ${file}`;
    return joinSections(
      "LSP diagnostics",
      entries.map((entry) => formatLspDiagnostics(entry.serverId, entry.file, entry.diagnostics, entry.root)),
    );
  }

  async shutdownAll(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.allSettled(clients.map((client) => client.shutdown()));
  }
}

const POSITION_PARAMS = Type.Object({
  path: Type.String({ description: "File path" }),
  line: Type.Number({ description: "Zero-based line number" }),
  character: Type.Number({ description: "Zero-based UTF-16 character offset" }),
});

const REFERENCES_PARAMS = Type.Object({
  path: Type.String({ description: "File path" }),
  line: Type.Number({ description: "Zero-based line number" }),
  character: Type.Number({ description: "Zero-based UTF-16 character offset" }),
  includeDeclaration: Type.Optional(Type.Boolean({ default: false, description: "Include the declaration in references" })),
});

export default function piLspExtension(pi: ExtensionAPI) {
  const manager = new LspManager();
  registerDiagnosticsRenderer(pi);

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
    if (event.isError) return undefined;

    const inputPath = getEventPath(event.input);
    if (!inputPath) return undefined;

    const file = toAbsolutePath(inputPath, ctx.cwd);
    const summary = await manager.updateDiagnosticsForFile(ctx, file);
    if (!summary.trim()) return undefined;

    if (hasIssueOutput(summary)) {
      pi.sendMessage({
        customType: "pi-lsp-diagnostics",
        content: "",
        display: true,
        details: { path: file, summary, toolCallId: event.toolCallId },
      }, { deliverAs: "steer" });
    }

    return { content: [...event.content, { type: "text", text: summary }] };
  });

  pi.on("session_shutdown", async () => {
    await manager.shutdownAll();
  });

  pi.registerTool({
    name: "lsp_diagnostics",
    label: "LSP Diagnostics",
    description: "Return latest LSP diagnostics collected for a file.",
    promptSnippet: "Inspect latest LSP diagnostics for a file",
    promptGuidelines: ["Use lsp_diagnostics to inspect latest LSP diagnostics after editing code."],
    parameters: Type.Object({ path: Type.String({ description: "File path" }) }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) return textToolResult("Cancelled");
      return textToolResult(manager.diagnosticsForPath(ctx, params.path));
    },
  });

  pi.registerTool({
    name: "lsp_hover",
    label: "LSP Hover",
    description: "Request hover information from the matching LSP server.",
    promptSnippet: "Request hover information at a file position",
    promptGuidelines: ["Use lsp_hover when symbol type or documentation from the language server would help answer accurately."],
    parameters: POSITION_PARAMS,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) return textToolResult("Cancelled");
      return textToolResult(await manager.navigate(ctx, params.path, { kind: "hover", line: params.line, character: params.character }));
    },
  });

  pi.registerTool({
    name: "lsp_definition",
    label: "LSP Definition",
    description: "Request definition locations from the matching LSP server.",
    promptSnippet: "Find definition locations for a symbol at a file position",
    promptGuidelines: ["Use lsp_definition to navigate to definitions through the language server instead of text search when available."],
    parameters: POSITION_PARAMS,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) return textToolResult("Cancelled");
      return textToolResult(await manager.navigate(ctx, params.path, { kind: "definition", line: params.line, character: params.character }));
    },
  });

  pi.registerTool({
    name: "lsp_references",
    label: "LSP References",
    description: "Request references from the matching LSP server.",
    promptSnippet: "Find references for a symbol at a file position",
    promptGuidelines: ["Use lsp_references to locate symbol usages through the language server when available."],
    parameters: REFERENCES_PARAMS,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) return textToolResult("Cancelled");
      return textToolResult(await manager.navigate(ctx, params.path, { kind: "references", line: params.line, character: params.character, includeDeclaration: params.includeDeclaration ?? false }));
    },
  });

  pi.registerTool({
    name: "lsp_symbols",
    label: "LSP Symbols",
    description: "Request document symbols from the matching LSP server.",
    promptSnippet: "List document symbols for a file using LSP",
    promptGuidelines: ["Use lsp_symbols to inspect file structure using the language server when available."],
    parameters: Type.Object({ path: Type.String({ description: "File path" }) }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) return textToolResult("Cancelled");
      return textToolResult(await manager.navigate(ctx, params.path, { kind: "symbols" }));
    },
  });
}
