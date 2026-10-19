import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

export type RepositoryTextSource = {
  path: string;
  text: string;
};

function normalizedRelativePath(absolutePath: string) {
  return path.relative(repositoryRoot, absolutePath).split(path.sep).join('/');
}

export function readRepositoryTextFile(relativePath: string) {
  return readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
}

export function readSourceTree(
  relativeDirectory: string,
  extensions: readonly string[],
): RepositoryTextSource[] {
  const root = path.join(repositoryRoot, relativeDirectory);
  const sources: RepositoryTextSource[] = [];

  function visit(directory: string) {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!entry.isFile() || !extensions.some((extension) => entry.name.endsWith(extension))) {
        continue;
      }
      sources.push({
        path: normalizedRelativePath(absolutePath),
        text: readFileSync(absolutePath, 'utf8'),
      });
    }
  }

  visit(root);
  return sources;
}

function escapedRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Finds a top-level function without making its file path part of the contract.
 * Relay's source uses one top-level closing brace per function declaration, so
 * this intentionally small reader is enough for structural tests and does not
 * depend on TypeScript's compiler API being exposed by the installed compiler.
 */
export function findUniqueFunctionSource(name: string) {
  const declaration = new RegExp(
    `^(?:export\\s+)?(?:async\\s+)?function\\s+${escapedRegExp(name)}\\s*\\(`,
  );
  const matches: Array<RepositoryTextSource & { declaration: string }> = [];

  for (const source of readSourceTree('src', ['.ts'])) {
    const lines = source.text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      if (!declaration.test(lines[index])) continue;
      let end = index + 1;
      while (end < lines.length && !/^}\s*$/.test(lines[end])) end += 1;
      if (end >= lines.length) {
        throw new Error(`Could not find the end of ${name} in ${source.path}.`);
      }
      matches.push({
        ...source,
        declaration: lines.slice(index, end + 1).join('\n'),
      });
    }
  }

  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one src function named ${name}; found ${matches.length}: `
      + matches.map((match) => match.path).join(', '),
    );
  }
  return matches[0];
}

export function staticModuleSpecifiers(source: RepositoryTextSource) {
  const specifiers = new Set<string>();
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.text.matchAll(pattern)) {
      if (match[1]) specifiers.add(match[1]);
    }
  }
  return [...specifiers].sort();
}

export function productionRuntimeSources() {
  return [
    ...readSourceTree('src', ['.ts']),
    ...readSourceTree('public', ['.js', '.html']),
  ];
}
