import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Identifies browser code: a content hash of public/ and shared/.
 *
 * A page carries the build it was served with, and Relay answers every
 * participant authentication with its own. A page left open across an update
 * reconnects with its old JavaScript; the differing build is how it learns to
 * ask for a reload (#487). A content hash rather than a git commit, because
 * the Pi serves its working tree directly and an edit there is a deployment.
 */
export function computeRelayBuild(dirs: readonly string[]): string {
  const hash = createHash('sha256');
  for (const dir of dirs) {
    for (const file of regularFiles(dir)) {
      hash.update(path.relative(dir, file));
      hash.update('\0');
      hash.update(readFileSync(file));
      hash.update('\0');
    }
  }
  return hash.digest('hex').slice(0, 12);
}

export type RelayBuildTracker = {
  /** The build of the files being served now. */
  current(): string;
};

/**
 * The build of what Relay is serving right now, not of what it started with.
 *
 * Relay reads index.html and every static file from disk on each request, so
 * an asset update reaches new page loads without a restart. A build computed
 * once at startup then named old and new pages identically, and a page left
 * open across that update was never asked to reload. The file sizes and
 * modification times are rechecked at most every `maxAgeMs`; the content is
 * hashed again only when they changed.
 */
export function createRelayBuildTracker(
  dirs: readonly string[],
  { maxAgeMs = 2_000, now = Date.now }: { maxAgeMs?: number; now?: () => number } = {},
): RelayBuildTracker {
  let signature = '';
  let build = '';
  let checkedAtMs = Number.NEGATIVE_INFINITY;
  return {
    current() {
      const nowMs = now();
      if (build && nowMs - checkedAtMs < maxAgeMs) return build;
      checkedAtMs = nowMs;
      const next = fileSignature(dirs);
      if (next !== signature || !build) {
        signature = next;
        build = computeRelayBuild(dirs);
      }
      return build;
    },
  };
}

function fileSignature(dirs: readonly string[]): string {
  const parts: string[] = [];
  for (const dir of dirs) {
    for (const file of regularFiles(dir)) {
      const stat = statSync(file);
      parts.push(`${file}\0${stat.size}\0${stat.mtimeMs}`);
    }
  }
  return parts.join('\n');
}

/** A build a page reported, or null for an old page or anything malformed. */
export function validPageBuild(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{1,64}$/.test(value) ? value : null;
}

function regularFiles(dir: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    // Symlinks are skipped: a local test setup links shared/ into public/.
    if (entry.isDirectory()) files.push(...regularFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}
