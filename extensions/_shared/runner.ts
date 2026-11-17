import fs from "node:fs";
import path from "node:path";

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathCandidates(bin: string): string[] {
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  const candidates: string[] = [];
  for (const entry of pathEntries) {
    for (const extension of extensions) {
      candidates.push(path.join(entry, `${bin}${extension}`));
    }
  }
  return candidates;
}

export function findExecutable(bin: string): string | undefined {
  if (path.isAbsolute(bin) || bin.includes("/") || bin.includes("\\")) {
    return isExecutable(bin) ? bin : undefined;
  }
  return pathCandidates(bin).find(isExecutable);
}

export function isExecutableAvailable(bin: string): boolean {
  return !!findExecutable(bin);
}
