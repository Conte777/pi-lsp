import path from "node:path";
import type { Diagnostic, DiagnosticRelatedInformation } from "vscode-languageserver-protocol";
import { uriToFilePath } from "./paths";

export function formatWarnings(title: string, warnings: string[]): string {
  if (warnings.length === 0) return "";
  return `${title}:\n\n${warnings.map((warning) => `⚠️ ${warning}`).join("\n")}`;
}

function severityLabel(severity: number | undefined): string {
  switch (severity) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 3:
      return "info";
    case 4:
      return "hint";
    default:
      return "diagnostic";
  }
}

function relatedInformationSuffix(relatedInformation: DiagnosticRelatedInformation[] | undefined): string[] {
  if (!relatedInformation || relatedInformation.length === 0) return [];
  return relatedInformation.slice(0, 3).map((item) => {
    let file = item.location.uri;
    try {
      file = uriToFilePath(item.location.uri);
    } catch {
      // keep URI as-is
    }
    return `  related: ${file}:${item.location.range.start.line + 1}:${item.location.range.start.character + 1} ${item.message}`;
  });
}

export function formatDiagnostic(file: string, diagnostic: Diagnostic, root?: string): string {
  const displayPath = root ? path.relative(root, file) || path.basename(file) : file;
  const line = diagnostic.range.start.line + 1;
  const character = diagnostic.range.start.character + 1;
  const source = diagnostic.source ? `${diagnostic.source}: ` : "";
  const code = diagnostic.code === undefined ? "" : ` [${String(diagnostic.code)}]`;
  const firstLine = `${displayPath}:${line}:${character} - ${severityLabel(diagnostic.severity)}: ${source}${diagnostic.message}${code}`;
  const related = relatedInformationSuffix(diagnostic.relatedInformation);
  return [firstLine, ...related].join("\n");
}

export function formatLspDiagnostics(serverId: string, file: string, diagnostics: Diagnostic[], root?: string): string {
  if (diagnostics.length === 0) return `✅ ${serverId}: no diagnostics`;
  const rendered = diagnostics.slice(0, 20).map((diagnostic) => formatDiagnostic(file, diagnostic, root));
  if (diagnostics.length > 20) rendered.push(`… ${diagnostics.length - 20} more diagnostics`);
  return `⚠️ ${serverId}:\n${rendered.join("\n")}`;
}

export function hasIssueOutput(output: string): boolean {
  return output.includes("⚠️");
}

export function joinSections(title: string, lines: string[]): string {
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  if (nonEmpty.length === 0) return "";
  return `${title}:\n\n${nonEmpty.join("\n")}`;
}
