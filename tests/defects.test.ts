import { afterEach, beforeEach, expect, test } from "vitest";
import { createHarness, type Harness, isAlive } from "./harness";

let h: Harness;
beforeEach(async () => { h = await createHarness(); });
afterEach(async () => { await h.close(); });

// Strict expected failures keep executable evidence without silently fixing
// production outside this task's ownership. Remove .fails with the owner repair.
const knownDefect = process.env.PI_LSP_REPRODUCE_DEFECTS === "1" ? test : test.fails;
knownDefect("concurrent navigation waits for initialization", async () => {
  await h.write("main.ts", "ok");
  await h.globalConfig([h.fixtureServer({ env: { LSP_TRANSCRIPT: h.transcript, LSP_MODE: "slow" } })]);
  const params = { path: "main.ts", line: 0, character: 0 };
  const first = h.call("lsp_hover", params);
  await expect.poll(async () => (await h.wire()).some((entry) => entry.method === "initialize")).toBe(true);
  const results = await Promise.allSettled([first, h.call("lsp_hover", params)]);
  expect(results.map((result) => result.status === "fulfilled" ? "fulfilled" : String(result.reason))).toEqual(["fulfilled", "fulfilled"]);
});

knownDefect("shutdown escalates when a subprocess ignores SIGTERM", async () => {
  await h.write("main.ts", "ok");
  await h.globalConfig([h.fixtureServer({ env: { LSP_TRANSCRIPT: h.transcript, LSP_MODE: "stubborn" } })]);
  await h.call("lsp_hover", { path: "main.ts", line: 0, character: 0 });
  const pid = (await h.wire()).find((entry) => entry.started)?.started;
  expect(pid).toBeTypeOf("number");
  try {
    await h.shutdown();
    await expect.poll(() => isAlive(pid as number), { timeout: 2600 }).toBe(false);
  } finally {
    if (pid && isAlive(pid)) process.kill(pid, "SIGKILL");
    await expect.poll(() => isAlive(pid as number)).toBe(false);
  }
});
