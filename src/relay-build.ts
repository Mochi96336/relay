import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Identifies the browser code this Relay process serves: a content hash of
 * public/ and shared/ as they were when it started.
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
