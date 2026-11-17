import fs from "node:fs";

// Independent wire peer: no extension imports and no shared transport implementation.
const log = (entry) => fs.appendFileSync(process.env.LSP_TRANSCRIPT, `${JSON.stringify(entry)}\n`);
log({ started: process.pid, cwd: process.cwd(), rootEnv: process.env.TEST_ROOT });
let pending = Buffer.alloc(0);
let initialized = false;
if (process.env.LSP_MODE === "stubborn") process.on("SIGTERM", () => {});
const documents = new Map();
const send = (message) => {
  const body = JSON.stringify({ jsonrpc: "2.0", ...message });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};
const publish = (uri, version, text) => send({
  method: "textDocument/publishDiagnostics",
  params: {
    uri, version,
    diagnostics: text.includes("BROKEN") ? [{
      range: { start: { line: 0, character: 2 }, end: { line: 0, character: 8 } },
      severity: 1, source: "wire-fixture", code: 17, message: "Invalid fixture document",
    }] : [],
  },
});
function receive(message) {
  log(message);
  const { id, method, params } = message;
  if (method?.startsWith("textDocument/") && !initialized) {
    if (id !== undefined) send({ id, error: { code: -32002, message: "Server not initialized" } });
    return;
  }
  if (method === "initialize") {
    if (process.env.LSP_MODE === "hang") return;
    const reply = () => {
      initialized = true;
      send({ id, result: { capabilities: {
        textDocumentSync: { openClose: true, change: 1, save: true },
        hoverProvider: true, definitionProvider: true, referencesProvider: true, documentSymbolProvider: true,
      } } });
    };
    if (process.env.LSP_MODE === "slow") setTimeout(reply, 500);
    else reply();
  } else if (method === "initialized") {
    send({ id: "settings", method: "workspace/configuration", params: { items: [{ section: "fixture" }, { section: "other" }] } });
    send({ id: "folders", method: "workspace/workspaceFolders" });
  } else if (method === "textDocument/didOpen") {
    documents.set(params.textDocument.uri, params.textDocument.text);
    publish(params.textDocument.uri, params.textDocument.version, params.textDocument.text);
  } else if (method === "textDocument/didChange") {
    documents.set(params.textDocument.uri, params.contentChanges[0].text);
    publish(params.textDocument.uri, params.textDocument.version, params.contentChanges[0].text);
  } else if (method === "textDocument/hover") {
    if (process.env.LSP_MODE === "crash") {
      process.stderr.write("fixture crashed\n", () => process.exit(23));
      return;
    }
    if (process.env.LSP_MODE === "error") send({ id, error: { code: -32603, message: "fixture request failed" } });
    else send({ id, result: { contents: { kind: "markdown", value: "**fixture hover λ**" } } });
  } else if (method === "textDocument/definition") {
    send({ id, result: null });
  } else if (method === "textDocument/references" || method === "textDocument/documentSymbol") {
    send({ id, result: [] });
  } else if (method === "shutdown") {
    send({ id, result: null });
  } else if (method === "exit" && process.env.LSP_MODE !== "stubborn") process.exit(0);
}
process.stdin.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (true) {
    const boundary = pending.indexOf("\r\n\r\n");
    if (boundary < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(pending.subarray(0, boundary).toString())[1]);
    if (pending.length < boundary + 4 + length) return;
    const body = pending.subarray(boundary + 4, boundary + 4 + length);
    pending = pending.subarray(boundary + 4 + length);
    receive(JSON.parse(body.toString()));
  }
});
