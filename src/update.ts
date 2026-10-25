// Self-update for the release binary. The website lists the latest build in /downloads/versions.json
// (written by scripts/release.ts on every deploy); /update downloads it over this binary.
// Windows can't overwrite a running .exe but can rename it, so the old one becomes peridot.exe.old and
// is deleted on the next start.
import { chmod, rename, rm, writeFile } from "node:fs/promises";
import { IS_RELEASE, VERSION } from "./version";

const WEB = "https://tryperidot.io";
const MANIFEST = `${WEB}/downloads/versions.json`;
const exe = process.execPath;

/** True when version a is newer than b ("1.2.10" > "1.2.9"). */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

async function manifest(): Promise<{ version: string; windows?: string; linux?: string }> {
  const res = await fetch(`${MANIFEST}?t=${Date.now()}`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Could not check for updates (HTTP ${res.status}).`);
  return ((await res.json()) as any).cli;
}

/** The newer version on the website, or null (also when offline or running from source). */
export async function latestVersion(): Promise<string | null> {
  if (!IS_RELEASE) return null;
  const m = await manifest().catch(() => null);
  return m && isNewer(m.version, VERSION) ? m.version : null;
}

/** Leftover from the previous update on Windows. */
export function cleanupOldBinary() {
  if (IS_RELEASE && process.platform === "win32") rm(`${exe}.old`, { force: true }).catch(() => {});
}

/** Downloads the latest binary over this one. Returns the new version. */
export async function selfUpdate(onProgress: (pct: number) => void): Promise<string> {
  if (!IS_RELEASE) throw new Error("This is a development run; update it with git instead.");
  const m = await manifest();
  const url = process.platform === "win32" ? m.windows : process.platform === "linux" ? m.linux : undefined;
  if (!url) throw new Error(`There is no automatic update for this system. Download Peridot again from ${WEB}.`);

  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}).`);
  const total = Number(res.headers.get("content-length")) || 0;
  const chunks: Uint8Array[] = [];
  let got = 0;
  for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
    got += chunk.length;
    if (total) onProgress(Math.floor((got / total) * 100));
  }
  if (total && got !== total) throw new Error("The download was interrupted. Try /update again.");

  const tmp = `${exe}.download`;
  let movedOld = false;
  try {
    await writeFile(tmp, Buffer.concat(chunks));
    await chmod(tmp, 0o755);
    if (process.platform === "win32") {
      await rm(`${exe}.old`, { force: true });
      await rename(exe, `${exe}.old`);
      movedOld = true;
    }
    await rename(tmp, exe);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    // Never leave the user without a peridot.exe
    if (movedOld) await rename(`${exe}.old`, exe).catch(() => {});
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(`No permission to replace ${exe}. Run Peridot with sudo and type /update, or download it again from ${WEB}.`);
    }
    throw e;
  }
  return m.version;
}
