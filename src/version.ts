import { fileURLToPath } from "node:url";

// Version: RELEASE.HUNDREDS.REST of the peridot-cli commit count, e.g. 140 commits -> 1.1.40.
// Release builds get the count baked in by scripts/build.ts; running from source counts it with git.
const RELEASE = 1;

declare const PERIDOT_COMMITS: number | undefined;

export function formatVersion(commits: number): string {
  return `${RELEASE}.${Math.floor(commits / 100)}.${commits % 100}`;
}

/** Commits that touched the CLI: in peridot-cli that is every commit, in the main repo those under cli/. */
export function countCommits(cwd: string): number | null {
  try {
    const res = Bun.spawnSync(["git", "rev-list", "--count", "HEAD", "--", "."], { cwd, stdout: "pipe", stderr: "ignore" });
    const n = Number(res.stdout.toString().trim());
    return res.exitCode === 0 && Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function current(): string {
  if (typeof PERIDOT_COMMITS === "number") return formatVersion(PERIDOT_COMMITS);
  const n = countCommits(fileURLToPath(new URL("..", import.meta.url)));
  return n ? formatVersion(n) : `${RELEASE}.0.0-dev`;
}

export const VERSION = current();

/** A release build (scripts/build.ts); runs from source never look for updates. */
export const IS_RELEASE = typeof PERIDOT_COMMITS === "number";
