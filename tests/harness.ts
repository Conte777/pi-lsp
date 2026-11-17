import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { ExtensionRunner, SessionManager, wrapRegisteredTools } from "@earendil-works/pi-coding-agent";
import type { ModelRegistry, ToolResultEvent } from "@earendil-works/pi-coding-agent";
// The package exposes discovery but not explicit loading at its root. Use the installed
// Pi loader directly to avoid discovering developer or ancestor extensions.
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

export const extensionPath = fileURLToPath(new URL("../extensions/pi-lsp/index.ts", import.meta.url));
export const fixturePath = fileURLToPath(new URL("./fixtures/lsp-server.mjs", import.meta.url));
export type Server = Record<string, unknown>;
export interface WireEntry {
  started?: number;
  cwd?: string;
  rootEnv?: string;
  method?: string;
  id?: string | number;
  params?: unknown;
  result?: unknown;
}

export async function createHarness() {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-lsp-test-")));
  const cwd = path.join(base, "workspace with spaces");
  const agentDir = path.join(base, "agent");
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(agentDir);
  const previous = process.env.PI_AGENT_DIR;
  process.env.PI_AGENT_DIR = agentDir;
  const loaded = await loadExtensions([extensionPath], cwd);
  expect(loaded.errors).toEqual([]);
  expect(loaded.extensions).toHaveLength(1);
  const messages: unknown[] = [];
  loaded.runtime.sendMessage = (...args) => { messages.push(args); };
  // No model operations participate in these tools. Supplying no registry ensures
  // an accidental model dependency fails instead of loading personal credentials.
  let runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, SessionManager.inMemory(cwd), undefined as unknown as ModelRegistry);
  const errors: unknown[] = [];
  runner.onError((error) => errors.push(error));
  let tools = wrapRegisteredTools(runner.getAllRegisteredTools(), runner);
  const transcript = path.join(base, "wire.jsonl");
  const fixtureServer = (overrides: Server = {}): Server => ({
    id: "fixture", bin: process.execPath, args: [fixturePath],
    include: ["**/*.ts"], diagnosticsWaitMs: 100,
    env: { LSP_TRANSCRIPT: transcript, TEST_ROOT: "{root}" }, ...overrides,
  });
  const write = async (name: string, text: string) => {
    const file = path.join(cwd, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
    return file;
  };
  const globalConfig = (servers: Server[]) => fs.writeFile(path.join(agentDir, "lsp.json"), JSON.stringify({ servers }));
  const projectConfig = (servers: Server[]) => write(".pi/lsp.json", JSON.stringify({ servers }));
  const wire = async (): Promise<WireEntry[]> => {
    try { return (await fs.readFile(transcript, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  };
  const call = async (name: string, params: Record<string, unknown>, signal?: AbortSignal) => {
    const tool = tools.find((tool) => tool.name === name);
    if (!tool) throw new Error(`Tool not registered: ${name}`);
    const result = await tool.execute("test-call", params, signal);
    return result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
  };
  const event = (name: string, toolName = "write", isError = false) => runner.emitToolResult({
    type: "tool_result", toolCallId: "write-call", toolName,
    input: { path: name }, content: [{ type: "text", text: "original tool result" }], details: {}, isError,
  } as ToolResultEvent);
  const shutdown = () => runner.emit({ type: "session_shutdown", reason: "quit" });
  const reload = async () => {
    await shutdown();
    const next = await loadExtensions([extensionPath], cwd);
    expect(next.errors).toEqual([]);
    next.runtime.sendMessage = (...args) => { messages.push(args); };
    runner = new ExtensionRunner(next.extensions, next.runtime, cwd, SessionManager.inMemory(cwd), undefined as unknown as ModelRegistry);
    runner.onError((error) => errors.push(error));
    tools = wrapRegisteredTools(runner.getAllRegisteredTools(), runner);
  };
  const close = async () => {
    try {
      await shutdown();
      // Verify the product's cleanup before the fallback so leaks cannot pass unnoticed.
      const pids = (await wire()).filter((entry) => entry.started).map((entry) => entry.started as number);
      await expect.poll(() => pids.filter(isAlive), { timeout: 3000 }).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      for (const entry of await wire()) if (entry.started && isAlive(entry.started)) process.kill(entry.started, "SIGKILL");
      if (previous === undefined) delete process.env.PI_AGENT_DIR;
      else process.env.PI_AGENT_DIR = previous;
      await fs.rm(base, { recursive: true, force: true });
    }
  };
  return { base, cwd, agentDir, get runner() { return runner; }, messages, transcript, fixtureServer, write, globalConfig, projectConfig, wire, call, event, shutdown, reload, close };
}

export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;
