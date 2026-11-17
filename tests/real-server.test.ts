import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createHarness, type Harness } from "./harness";

const server = process.env.PI_LSP_REAL_SERVER ?? "typescript-language-server";
const available = spawnSync(server, ["--version"], { encoding: "utf8" });
let h: Harness;
beforeEach(async () => { h = await createHarness(); });
afterEach(async () => { await h.close(); });

test.skipIf(available.error?.message.includes("ENOENT"))("runs semantic TypeScript diagnostics and navigation with a real server", async () => {
  expect(available.status, available.stderr).toBe(0);
  await h.write("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["*.ts"] }));
  const file = await h.write("main.ts", "export const answer: number = 'wrong';\nconsole.log(answer);\n");
  await h.globalConfig([{
    id: "typescript", bin: server, args: ["--stdio"],
    include: ["**/*.ts"], rootMarkers: ["tsconfig.json"],
    languageIdByExtension: { ".ts": "typescript" }, diagnosticsWaitMs: 1800,
    initializationOptions: { preferences: { includeInlayParameterNameHints: "none" } },
  }]);
  const event = await h.event("main.ts");
  expect(event?.content?.[0]).toEqual({ type: "text", text: "original tool result" });
  await expect.poll(() => h.call("lsp_diagnostics", { path: "main.ts" }), { timeout: 10_000 }).toContain("not assignable to type 'number'");
  const position = { path: "main.ts", line: 1, character: 14 };
  const hover = JSON.parse(await h.call("lsp_hover", position));
  expect(JSON.stringify(hover.contents)).toContain("answer: number");
  const definitions = JSON.parse(await h.call("lsp_definition", position));
  expect(definitions).toMatchObject([{ uri: pathToFileURL(file).href, range: { start: { line: 0, character: 13 } } }]);
  const references = JSON.parse(await h.call("lsp_references", { ...position, includeDeclaration: true }));
  expect(references).toEqual(expect.arrayContaining([
    expect.objectContaining({ uri: pathToFileURL(file).href, range: expect.objectContaining({ start: { line: 0, character: 13 } }) }),
    expect.objectContaining({ uri: pathToFileURL(file).href, range: expect.objectContaining({ start: { line: 1, character: 12 } }) }),
  ]));
  const symbols = JSON.parse(await h.call("lsp_symbols", { path: "main.ts" }));
  expect(symbols).toEqual(expect.arrayContaining([expect.objectContaining({ name: "answer" })]));
  await h.write("main.ts", "export const answer: number = 42;\nconsole.log(answer);\n");
  const fixed = await h.event("main.ts", "edit");
  expect(fixed?.content?.[0]).toEqual({ type: "text", text: "original tool result" });
  await expect.poll(() => h.call("lsp_diagnostics", { path: "main.ts" }), { timeout: 10_000 }).toContain("no diagnostics recorded");
});
