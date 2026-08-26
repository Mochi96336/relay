import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

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

function scriptKind(sourcePath: string) {
  return sourcePath.endsWith('.js') || sourcePath.endsWith('.mjs')
    ? ts.ScriptKind.JS
    : ts.ScriptKind.TS;
}

function parsedSource(source: RepositoryTextSource) {
  return ts.createSourceFile(
    source.path,
    source.text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(source.path),
  );
}

export function findUniqueFunctionSource(name: string) {
  const matches: Array<RepositoryTextSource & { declaration: string }> = [];

  for (const source of readSourceTree('src', ['.ts'])) {
    const sourceFile = parsedSource(source);
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
        matches.push({ ...source, declaration: node.getText(sourceFile) });
      }
      node.forEachChild(visit);
    };
    sourceFile.forEachChild(visit);
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
  const sourceFile = parsedSource(source);
  const specifiers = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.add(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.add(node.arguments[0].text);
    }
    node.forEachChild(visit);
  };

  sourceFile.forEachChild(visit);
  return [...specifiers].sort();
}

export function productionRuntimeSources() {
  return [
    ...readSourceTree('src', ['.ts']),
    ...readSourceTree('public', ['.js', '.html']),
  ];
}
