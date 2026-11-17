# Working on pi-lsp

## Before changing behavior

- Read the relevant configuration and tool contracts in `README.md`, then trace their implementation. Update the README when a user-visible contract changes.
- Read installed dependency source before relying on Pi event, UI, or JSON-RPC behavior. Use the versions actually installed; peer dependencies are unpinned.
- For each affected input, dependency, and state transition, identify credible failures and pair each with an implementation decision and an end-to-end verification signal. Report unresolved cases.

## Compatibility

- Preserve global/project configuration precedence and project-config trust checks when adding configuration sources.
- Keep subprocess commands as executable plus argument arrays with `shell: false`.
- Preserve the distinction between cached diagnostics and a fresh server request: `lsp_diagnostics` reads recorded diagnostics and does not trigger analysis.
- Keep diagnostic failures separate from the original successful edit. Verify both the appended tool output and the user-visible diagnostic notice when changing this flow.
- Preserve server reuse by `(server id, root)` and session shutdown cleanup when changing client lifecycle behavior.

## Verification

- This checkout was recovered from `pi-lsp@0.1.7`. The published scripts reference tests and TypeScript configuration that were absent from the archive. Treat those checks as unavailable until their inputs are restored; report this gap in validation results.
- For documentation-only changes, check the diff, links, and examples against the implementation.
- For runtime changes, load the local extension in Pi and exercise each changed behavior with a real language server. Include the affected failure paths and record the observable result for each; unit tests alone do not establish completion.
- Use a temporary workspace and a temporary `PI_AGENT_DIR` for runtime verification so configuration and trust decisions stay isolated from the developer's setup. Install the local extension in that isolated environment.
