# Test authoring gate and failure map

These are integration tests through the installed Pi loader, ExtensionRunner,
registered tools, real files and a subprocess. No production exports or hooks
were added. Each row is one primary test owner, named identically in the suite.
There was no prior coverage. No tests are source inventories or helper replays.

| Test | Independent observable contract | Credible failure and implementation decision | Verification / why separate |
| --- | --- | --- | --- |
| rejects untrusted project commands without spawning | Project config cannot auto-run in noninteractive Pi | A config bypass starts an attacker-controlled binary; retain rejection | Warning, empty child transcript, no trust file; distinct authorization guard |
| persists explicit trust and invalidates it when config bytes change | Trust always survives sessions but does not authorize changed bytes | Hash ignored or persistence never written; use real UI choice and store | New Pi instance runs unchanged config without UI, changed config denied |
| trusts once without persisting and honors project disable overrides | Trust once is temporary; project disabled ID removes global command | Once accidentally persists or merge ignores disable | New Pi instance denies project and executes global fallback; no stored hash |
| reports malformed config while retaining valid global servers | Invalid project JSON cannot break global diagnostics | Parse error aborts all loading; preserve warning and global execution | Event output and real child start, distinct parse failure |
| matches roots and paths without starting irrelevant servers | Include/exclude, root markers, outside-root and file size guards | Wrong root or ignored filters spawn unwanted processes | No starts for isolated guards, then valid start cwd/root URI/env; positive control |
| delivers edit diagnostics and clears them after correction | Successful edit/write augments original result and publishes issues | Missing event, lost original output, stale diagnostics, duplicate opens | Wire open/change/save/version and user messages/cache; one owner for sync |
| forwards navigation and server workspace requests over JSON-RPC | Coordinates are UTF-16 offsets, file URIs escaped, references context and settings returned | Wrong method/coordinates/config callback or dropped Unicode response | Transcript and public tool output; transport contract real semantic test cannot fully isolate |
| ignores failed writes and unrelated tools and cancels before starting | Failed tools cannot trigger auto-analysis; pre-aborted tools do no work | Event filter removed or abort checked too late | No wire transcript, positive successful event starts same config |
| reports missing binaries and backs off repeated startup failures | Unavailable server does not turn write into failure or tight retry loop | Missing binary escapes handler or no backoff | Warning then retry-after warning, original content retained |
| bounds initialization and shuts down a hung server | Startup deadline and session cleanup remain bounded | Never-initializing process hangs event or survives shutdown | Measured event deadline, warning, PID disappearance |
| propagates request errors and restarts crashed subprocesses | Navigation failures are visible and subsequent calls can recover | RPC errors swallowed or dead connection reused | Tool rejection, old PID exits, next edit starts a fresh process |
| runs semantic TypeScript diagnostics and navigation with a real server | Actual language semantics work through Pi and stdio | Fixture-only success hides interoperability/sync bugs | Real type error, fix, hover, definition, references, symbols; optional only if binary unavailable |
| concurrent navigation waits for initialization | No document request precedes initialize response | Connection is assigned before the initialization promise resolves; concurrent tool enters early | Slow independent peer rejects pre-initialization traffic; both public calls must fulfill |
| shutdown escalates when a subprocess ignores SIGTERM | Session shutdown eventually terminates an uncooperative server | ChildProcess.killed means signal sent, not process exited; fallback never fires | Actual peer ignores exit/SIGTERM; PID must disappear after escalation deadline |

All tests pass the four-question authoring gate: each row states its behavior,
failure, unique owner and observable proof; none requires a production seam.
The wire fixture is an independent peer that records incoming messages. It does
not decide trust, matching, command resolution, document versions or rendering.
Its canned responses verify transport and delivery only, not language semantics.

## Reproduce

- `npm run verify` runs lint, production/test typecheck and integration suite.
- `npm test -- tests/extension.test.ts` runs deterministic protocol/contracts.
- `npm test -- tests/real-server.test.ts` runs the real-server path.
- `npm pack --dry-run` runs prepack/verify and checks the publish manifest.
- `git diff --check` checks whitespace.

The real test uses `typescript-language-server` from PATH or
`PI_LSP_REAL_SERVER=/absolute/path/to/typescript-language-server`. It explicitly
skips if that executable cannot be launched. A working TypeScript installation
is also required by that server. Tests create temporary workspaces and agent
directories; no API key, model request or personal Pi config is used.

The runner-level tests are not a full CLI/model session. A subsequent full e2e
session should install the local package in a temporary Pi agent/workspace,
exercise actual write/edit tool execution and observe diagnostics/custom messages,
navigation and session shutdown. No fixture can replace that acceptance check.

## Lifecycle regressions

`npm test -- tests/defects.test.ts` runs two ordinary behavioral regressions.
Both failed on the pre-fix owner: concurrent navigation returned
`Server not initialized`, and the SIGTERM-ignoring child survived 2600ms.
All callers now await the shared initialization promise; shutdown checks actual
process termination before escalating to SIGKILL after 2 seconds. The stuck
peer's cleanup fallback runs only after the product's deadline is observed.
Normal `npm run verify` includes these regressions without expected failures.
