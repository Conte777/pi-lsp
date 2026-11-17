import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createHarness, type Harness, isAlive } from "./harness";

let h: Harness;
beforeEach(async () => { h = await createHarness(); });
afterEach(async () => { await h.close(); });
const text = (result: Awaited<ReturnType<Harness["event"]>>) => result?.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n") ?? "";

test("rejects untrusted project commands without spawning", async () => {
  await h.write("main.ts", "BROKEN");
  await h.projectConfig([h.fixtureServer()]);
  expect(text(await h.event("main.ts"))).toContain("project-local config rejected in non-interactive mode");
  expect(await h.call("lsp_hover", { path: "main.ts", line: 0, character: 0 })).toContain("No matching LSP server");
  expect(await h.wire()).toEqual([]);
  await expect(fs.stat(path.join(h.agentDir, "trust/lsp.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("persists explicit trust and invalidates it when config bytes change", async () => {
  await h.write("main.ts", "BROKEN");
  await h.globalConfig([{ id: "fixture", bin: path.join(h.base, "must-be-overridden") }]);
  const config = await h.projectConfig([h.fixtureServer()]);
  const prompts: string[] = [];
  h.runner.setUIContext({ ...h.runner.getUIContext(), select: async (title) => { prompts.push(title); return "Trust always"; } }, "tui");
  expect(text(await h.event("main.ts"))).toContain("Invalid fixture document");
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain(config);
  expect(prompts[0]).toContain(process.execPath);
  const stored = JSON.parse(await fs.readFile(path.join(h.agentDir, "trust/lsp.json"), "utf8"));
  expect(stored.trustedHashes).toHaveLength(1);
  await h.reload();
  expect(text(await h.event("main.ts"))).toContain("Invalid fixture document");
  await fs.appendFile(config, "\n");
  expect(text(await h.event("main.ts"))).toContain("rejected in non-interactive mode");
  expect((await h.wire()).filter((entry) => entry.method === "textDocument/didOpen")).toHaveLength(2);
});

test("trusts once without persisting and honors project disable overrides", async () => {
  await h.write("main.ts", "BROKEN");
  await h.globalConfig([h.fixtureServer()]);
  await h.projectConfig([{ id: "fixture", enabled: false }]);
  h.runner.setUIContext({ ...h.runner.getUIContext(), select: async () => "Trust once" }, "tui");
  expect(await h.event("main.ts")).toBeUndefined();
  expect(await h.wire()).toEqual([]);
  await expect(fs.stat(path.join(h.agentDir, "trust/lsp.json"))).rejects.toMatchObject({ code: "ENOENT" });
  await h.reload();
  const output = text(await h.event("main.ts"));
  expect(output).toContain("rejected in non-interactive mode");
  expect(output).toContain("Invalid fixture document");
  expect((await h.wire()).filter((entry) => entry.started)).toHaveLength(1);
});

test("reports malformed config while retaining valid global servers", async () => {
  await h.write("main.ts", "BROKEN");
  await h.globalConfig([h.fixtureServer()]);
  await h.write(".pi/lsp.json", "{ invalid JSON");
  const output = text(await h.event("main.ts"));
  expect(output).toContain("Failed to load project lsp config");
  expect(output).toContain("Invalid fixture document");
});

test("matches roots and paths without starting irrelevant servers", async () => {
  await h.write("project/root.marker", "");
  await h.write("project/src/main.ts", "ok");
  await h.write("project/src/skip.ts", "ok");
  await h.write("project/src/main.txt", "ok");
  await h.write("outside.ts", "ok");
  await h.globalConfig([h.fixtureServer({ include: ["**/*.ts"], exclude: ["**/skip.ts"], rootMarkers: ["root.marker"], maxFileSizeBytes: 3 })]);
  expect(await h.event("project/src/skip.ts")).toBeUndefined();
  expect(await h.event("project/src/main.txt")).toBeUndefined();
  expect(text(await h.event("outside.ts"))).toContain("root markers not found");
  await h.write("project/src/large.ts", "too large");
  expect(text(await h.event("project/src/large.ts"))).toContain("file exceeds maxFileSizeBytes (3)");
  expect(await h.wire()).toEqual([]);
  expect(text(await h.event("project/src/main.ts"))).toContain("no diagnostics");
  const root = path.join(h.cwd, "project");
  const wire = await h.wire();
  expect(wire.find((entry) => entry.started)).toMatchObject({ cwd: root, rootEnv: root });
  expect(wire.find((entry) => entry.method === "initialize")).toMatchObject({ params: { rootUri: pathToFileURL(root).href } });
  await h.write("second/root.marker", "");
  await h.write("second/other.ts", "ok");
  expect(text(await h.event("second/other.ts"))).toContain("no diagnostics");
  expect((await h.wire()).filter((entry) => entry.started)).toHaveLength(2);
  await h.globalConfig([h.fixtureServer()]);
  await fs.writeFile(path.join(h.base, "outside.ts"), "ok");
  expect(await h.call("lsp_hover", { path: "../outside.ts", line: 0, character: 0 })).toContain("No matching LSP server");
  expect((await h.wire()).filter((entry) => entry.started)).toHaveLength(2);
});

test("delivers edit diagnostics and clears them after correction", async () => {
  await h.globalConfig([h.fixtureServer({ languageIdByExtension: { ".ts": "typescript" } })]);
  await h.write("main.ts", "BROKEN λ");
  const output = text(await h.event("main.ts"));
  expect(output).toContain("original tool result");
  expect(output).toContain("main.ts:1:3 - error: wire-fixture: Invalid fixture document [17]");
  expect(h.messages).toMatchObject([[{ customType: "pi-lsp-diagnostics", details: { toolCallId: "write-call" } }, { deliverAs: "steer" }]]);
  expect(await h.call("lsp_diagnostics", { path: "main.ts" })).toContain("Invalid fixture document");
  await h.write("main.ts", "fixed λ");
  expect(text(await h.event("main.ts", "edit"))).toContain("no diagnostics");
  expect(await h.call("lsp_diagnostics", { path: "main.ts" })).toContain("no diagnostics recorded");
  expect(h.messages).toHaveLength(1);
  const wire = await h.wire();
  expect(wire.filter((entry) => entry.started)).toHaveLength(1);
  expect(wire.filter((entry) => entry.method === "textDocument/didOpen")).toMatchObject([{ params: { textDocument: { languageId: "typescript", version: 1, text: "BROKEN λ" } } }]);
  expect(wire.filter((entry) => entry.method === "textDocument/didChange")).toMatchObject([{ params: { textDocument: { version: 2 }, contentChanges: [{ text: "fixed λ" }] } }]);
  await expect.poll(async () => (await h.wire()).filter((entry) => entry.method === "textDocument/didSave").length).toBe(2);
  const pid = wire.find((entry) => entry.started)?.started;
  expect(pid).toBeTypeOf("number");
  await h.shutdown();
  await expect.poll(() => isAlive(pid as number)).toBe(false);
});

test("forwards navigation and server workspace requests over JSON-RPC", async () => {
  const file = await h.write("src/λ #.ts", "const face = '😀';\nface;");
  await h.globalConfig([h.fixtureServer({ settings: { fixture: true }, initializationOptions: { token: "test" } })]);
  const params = { path: "src/λ #.ts", line: 1, character: 3 };
  expect(JSON.parse(await h.call("lsp_hover", params))).toMatchObject({ contents: { value: "**fixture hover λ**" } });
  expect(await h.call("lsp_definition", params)).toBe("No result");
  expect(JSON.parse(await h.call("lsp_references", params))).toEqual([]);
  await h.call("lsp_references", { ...params, includeDeclaration: true });
  expect(JSON.parse(await h.call("lsp_symbols", { path: params.path }))).toEqual([]);
  const wire = await h.wire();
  expect(wire.find((entry) => entry.method === "textDocument/hover")).toMatchObject({ params: { textDocument: { uri: pathToFileURL(file).href }, position: { line: 1, character: 3 } } });
  expect(wire.find((entry) => entry.method === "textDocument/definition")).toMatchObject({ params: { position: { line: 1, character: 3 } } });
  expect(wire.filter((entry) => entry.method === "textDocument/references")).toMatchObject([{ params: { context: { includeDeclaration: false } } }, { params: { context: { includeDeclaration: true } } }]);
  expect(wire.find((entry) => entry.method === "initialize")).toMatchObject({ params: { initializationOptions: { token: "test" } } });
  expect(wire.find((entry) => entry.method === "workspace/didChangeConfiguration")).toMatchObject({ params: { settings: { fixture: true } } });
  expect(wire.find((entry) => entry.id === "settings" && "result" in entry)).toMatchObject({ result: [{ fixture: true }, { fixture: true }] });
  expect(wire.find((entry) => entry.id === "folders" && "result" in entry)).toMatchObject({ result: [{ uri: pathToFileURL(h.cwd).href }] });
});

test("ignores failed writes and unrelated tools and cancels before starting", async () => {
  await h.globalConfig([h.fixtureServer()]);
  await h.write("main.ts", "ok");
  expect(await h.event("main.ts", "write", true)).toBeUndefined();
  expect(await h.event("main.ts", "read")).toBeUndefined();
  expect(await h.event("")).toBeUndefined();
  expect(await h.call("lsp_hover", { path: "main.ts", line: 0, character: 0 }, AbortSignal.abort())).toBe("Cancelled");
  expect(await h.wire()).toEqual([]);
  expect(text(await h.event("main.ts"))).toContain("no diagnostics");
});

test("reports missing binaries and backs off repeated startup failures", async () => {
  await h.globalConfig([h.fixtureServer({ bin: path.join(h.base, "missing-binary") })]);
  await h.write("main.ts", "ok");
  expect(text(await h.event("main.ts"))).toContain("LSP binary not found");
  const retry = text(await h.event("main.ts"));
  expect(retry).toContain("retry after");
  expect(retry).toContain("original tool result");
  expect(await h.wire()).toEqual([]);
});

test("bounds initialization and shuts down a hung server", async () => {
  await h.globalConfig([h.fixtureServer({ startupTimeoutMs: 150, env: { LSP_TRANSCRIPT: h.transcript, LSP_MODE: "hang" } })]);
  await h.write("main.ts", "ok");
  const started = Date.now();
  expect(text(await h.event("main.ts"))).toContain("initialize timed out after 150ms");
  expect(Date.now() - started).toBeLessThan(3000);
  expect((await h.wire()).filter((entry) => entry.started)).toHaveLength(1);
  // afterEach verifies the observed PID exits even when initialization never replied.
});

test("propagates request errors and restarts crashed subprocesses", async () => {
  await h.write("main.ts", "ok");
  await h.globalConfig([h.fixtureServer({ env: { LSP_TRANSCRIPT: h.transcript, LSP_MODE: "error" } })]);
  await expect(h.call("lsp_hover", { path: "main.ts", line: 0, character: 0 })).rejects.toThrow("fixture request failed");
  await h.shutdown();
  await expect.poll(async () => (await h.wire()).filter((entry) => entry.started && isAlive(entry.started)).length).toBe(0);
  await h.globalConfig([h.fixtureServer({ id: "crasher", env: { LSP_TRANSCRIPT: h.transcript, LSP_MODE: "crash" } })]);
  await expect(h.call("lsp_hover", { path: "main.ts", line: 0, character: 0 })).rejects.toThrow();
  await expect.poll(async () => (await h.wire()).filter((entry) => entry.started && isAlive(entry.started)).length).toBe(0);
  expect(text(await h.event("main.ts"))).toContain("no diagnostics");
  expect((await h.wire()).filter((entry) => entry.started)).toHaveLength(3);
});
