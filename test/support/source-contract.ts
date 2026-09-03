import assert from 'node:assert/strict';

type SourceContract = {
  fileName: string;
  text: string;
  codeMask: string;
};

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function maskNonCode(text: string) {
  const chars = Array.from(text);
  let mode: 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' | 'template' = 'code';

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    const next = chars[index + 1];

    if (mode === 'code') {
      if (char === '/' && next === '/') {
        chars[index] = ' ';
        chars[index + 1] = ' ';
        index += 1;
        mode = 'line-comment';
      } else if (char === '/' && next === '*') {
        chars[index] = ' ';
        chars[index + 1] = ' ';
        index += 1;
        mode = 'block-comment';
      } else if (char === "'") {
        chars[index] = ' ';
        mode = 'single';
      } else if (char === '"') {
        chars[index] = ' ';
        mode = 'double';
      } else if (char === '`') {
        chars[index] = ' ';
        mode = 'template';
      }
      continue;
    }

    if (mode === 'line-comment') {
      if (char === '\n') mode = 'code';
      else chars[index] = ' ';
      continue;
    }

    if (mode === 'block-comment') {
      if (char === '*' && next === '/') {
        chars[index] = ' ';
        chars[index + 1] = ' ';
        index += 1;
        mode = 'code';
      } else if (char !== '\n') chars[index] = ' ';
      continue;
    }

    if (char === '\\') {
      chars[index] = ' ';
      if (index + 1 < chars.length && chars[index + 1] !== '\n') {
        chars[index + 1] = ' ';
        index += 1;
      }
      continue;
    }

    const closes =
      (mode === 'single' && char === "'")
      || (mode === 'double' && char === '"')
      || (mode === 'template' && char === '`');
    if (char !== '\n') chars[index] = ' ';
    if (closes) mode = 'code';
  }

  return chars.join('');
}

function stripComments(text: string) {
  const chars = Array.from(text);
  let mode: 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' | 'template' = 'code';

  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    const next = chars[index + 1];

    if (mode === 'code') {
      if (char === '/' && next === '/') {
        chars[index] = ' ';
        chars[index + 1] = ' ';
        index += 1;
        mode = 'line-comment';
      } else if (char === '/' && next === '*') {
        chars[index] = ' ';
        chars[index + 1] = ' ';
        index += 1;
        mode = 'block-comment';
      } else if (char === "'") mode = 'single';
      else if (char === '"') mode = 'double';
      else if (char === '`') mode = 'template';
      continue;
    }

    if (mode === 'line-comment') {
      if (char === '\n') mode = 'code';
      else chars[index] = ' ';
      continue;
    }

    if (mode === 'block-comment') {
      if (char === '*' && next === '/') {
        chars[index] = ' ';
        chars[index + 1] = ' ';
        index += 1;
        mode = 'code';
      } else if (char !== '\n') chars[index] = ' ';
      continue;
    }

    if (char === '\\') {
      index += 1;
      continue;
    }

    const closes =
      (mode === 'single' && char === "'")
      || (mode === 'double' && char === '"')
      || (mode === 'template' && char === '`');
    if (closes) mode = 'code';
  }

  return chars.join('');
}

function matchingDelimiter(code: string, start: number, open: string, close: string) {
  assert.equal(code[start], open, `expected ${open} at structural range start`);
  let depth = 0;
  for (let index = start; index < code.length; index += 1) {
    if (code[index] === open) depth += 1;
    else if (code[index] === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  assert.fail(`unterminated ${open}${close} structural range`);
}

function functionMatches(source: SourceContract, name: string) {
  const pattern = new RegExp(`\\bfunction\\s+${escapeRegExp(name)}\\s*\\(`, 'g');
  return Array.from(source.codeMask.matchAll(pattern));
}

export function parseTypeScriptSource(url: URL, text: string): SourceContract {
  return {
    fileName: url.pathname,
    text,
    codeMask: maskNonCode(text),
  };
}

export function functionCode(source: SourceContract, name: string) {
  const matches = functionMatches(source, name);
  assert.equal(matches.length, 1, `expected exactly one function declaration named ${name} in ${source.fileName}`);
  const start = matches[0].index;
  const openParen = source.codeMask.indexOf('(', start);
  const closeParen = matchingDelimiter(source.codeMask, openParen, '(', ')');
  const bodyStart = source.codeMask.indexOf('{', closeParen + 1);
  assert.ok(bodyStart >= 0, `${name} must keep a function body`);
  const bodyEnd = matchingDelimiter(source.codeMask, bodyStart, '{', '}');
  return stripComments(source.text.slice(start, bodyEnd + 1));
}

export function hasFunction(source: SourceContract, name: string) {
  return functionMatches(source, name).length > 0;
}

export function variableInitializerCode(source: SourceContract, name: string) {
  const pattern = new RegExp(`\\b(?:const|let|var)\\s+${escapeRegExp(name)}\\b`, 'g');
  const matches = Array.from(source.codeMask.matchAll(pattern));
  assert.equal(matches.length, 1, `expected exactly one variable declaration named ${name} in ${source.fileName}`);

  const declarationStart = matches[0].index + matches[0][0].length;
  const equals = source.codeMask.indexOf('=', declarationStart);
  assert.ok(equals >= 0, `${name} must keep an initializer`);

  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (let index = equals + 1; index < source.codeMask.length; index += 1) {
    const char = source.codeMask[index];
    if (char === '(') paren += 1;
    else if (char === ')') paren -= 1;
    else if (char === '[') bracket += 1;
    else if (char === ']') bracket -= 1;
    else if (char === '{') brace += 1;
    else if (char === '}') brace -= 1;
    else if (char === ';' && paren === 0 && bracket === 0 && brace === 0) {
      return stripComments(source.text.slice(equals + 1, index).trim());
    }
  }

  assert.fail(`unterminated initializer for ${name}`);
}

export function importSources(source: SourceContract) {
  const code = stripComments(source.text);
  const pattern = /^\s*import(?:\s+type)?(?:[\s\S]*?\s+from\s+)?\s*['"]([^'"]+)['"]\s*;?\s*$/gm;
  return Array.from(code.matchAll(pattern), (match) => match[1]);
}

export function sourceCode(source: SourceContract) {
  return stripComments(source.text);
}
