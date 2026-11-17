import type { Diagnostic } from "vscode-languageserver-protocol";

export type ConfigKind = "lsp";

export interface MatchableConfig {
  id: string;
  enabled?: boolean;
  include?: string[];
  exclude?: string[];
  rootMarkers?: string[];
  maxFileSizeBytes?: number;
}

export interface LspServerConfig extends MatchableConfig {
  bin: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  config?: string;
  languageIdByExtension?: Record<string, string>;
  startupTimeoutMs?: number;
  diagnosticsWaitMs?: number;
  initializationOptions?: unknown;
  settings?: unknown;
}

export interface LspConfigFile {
  version?: number;
  servers?: LspServerConfig[];
}

export interface ConfigLayer<TItem extends MatchableConfig> {
  scope: "global" | "project";
  path: string;
  dir: string;
  raw: string;
  hash: string;
  items: TItem[];
}

export interface LoadedConfig<TItem extends MatchableConfig> {
  items: TItem[];
  layers: ConfigLayer<TItem>[];
  warnings: string[];
}

export interface PathPlaceholders {
  workspace: string;
  root: string;
  file: string;
  relFile: string;
  dir: string;
  relDir: string;
  config: string;
  configDir: string;
}

export interface ResolvedCommand {
  id: string;
  bin: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  configPath?: string;
  placeholders: PathPlaceholders;
}

export interface StoredDiagnostics {
  serverId: string;
  root: string;
  file: string;
  version?: number;
  diagnostics: Diagnostic[];
  updatedAt: number;
}
