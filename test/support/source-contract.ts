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
  const pattern = new RegExp(`\\bfunction\\s+${escapeRegExp(name)}\\b`, 'g');
  return Array.from(source.codeMask.matchAll(pattern)).flatMap((match) => {
    const start = match.index;
    let cursor = start + match[0].length;
    while (/\s/.test(source.codeMask[cursor] ?? '')) cursor += 1;

    if (source.codeMask[cursor] === '<') {
      let depth = 0;
      for (; cursor < source.codeMask.length; cursor += 1) {
        const char = source.codeMask[cursor];
        if (char === '<') depth += 1;
        else if (char === '>' && source.codeMask[cursor - 1] !== '=') {
          depth -= 1;
          if (depth === 0) {
            cursor += 1;
            break;
          }
        }
      }
      if (depth !== 0) return [];
      while (/\s/.test(source.codeMask[cursor] ?? '')) cursor += 1;
    }

    if (source.codeMask[cursor] !== '(') return [];
    return [{ index: start, openParen: cursor }];
  });
}

function classRange(source: SourceContract, name: string) {
  const pattern = new RegExp(`\\bclass\\s+${escapeRegExp(name)}\\b`, 'g');
  const matches = Array.from(source.codeMask.matchAll(pattern));
  assert.equal(matches.length, 1, `expected exactly one class declaration named ${name} in ${source.fileName}`);
  const start = matches[0].index;
  const bodyStart = source.codeMask.indexOf('{', start + matches[0][0].length);
  assert.ok(bodyStart >= 0, `${name} must keep a class body`);
  const bodyEnd = matchingDelimiter(source.codeMask, bodyStart, '{', '}');
  return { start, bodyStart, bodyEnd };
}

function braceDepthAt(code: string, start: number, end: number) {
  let depth = 0;
  for (let index = start; index < end; index += 1) {
    if (code[index] === '{') depth += 1;
    else if (code[index] === '}') depth -= 1;
  }
  return depth;
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
  const openParen = matches[0].openParen;
  const closeParen = matchingDelimiter(source.codeMask, openParen, '(', ')');
  const bodyStart = source.codeMask.indexOf('{', closeParen + 1);
  assert.ok(bodyStart >= 0, `${name} must keep a function body`);
  const bodyEnd = matchingDelimiter(source.codeMask, bodyStart, '{', '}');
  return stripComments(source.text.slice(start, bodyEnd + 1));
}

export function hasFunction(source: SourceContract, name: string) {
  return functionMatches(source, name).length > 0;
}

export function classMethodCode(source: SourceContract, className: string, methodName: string) {
  const range = classRange(source, className);
  const pattern = new RegExp(`\\b${escapeRegExp(methodName)}\\s*\\(`, 'g');
  const candidates = Array.from(source.codeMask.matchAll(pattern))
    .filter((match) => {
      const index = match.index;
      if (index <= range.bodyStart || index >= range.bodyEnd) return false;
      if (braceDepthAt(source.codeMask, range.bodyStart, index) !== 1) return false;
      let previous = index - 1;
      while (previous > range.bodyStart && /\s/.test(source.codeMask[previous])) previous -= 1;
      return source.codeMask[previous] !== '.';
    });
  assert.equal(
    candidates.length,
    1,
    `expected exactly one top-level method named ${className}.${methodName} in ${source.fileName}`,
  );

  const start = candidates[0].index;
  const openParen = source.codeMask.indexOf('(', start);
  const closeParen = matchingDelimiter(source.codeMask, openParen, '(', ')');
  const bodyStart = source.codeMask.indexOf('{', closeParen + 1);
  assert.ok(bodyStart >= 0 && bodyStart < range.bodyEnd, `${className}.${methodName} must keep a method body`);
  const bodyEnd = matchingDelimiter(source.codeMask, bodyStart, '{', '}');
  assert.ok(bodyEnd <= range.bodyEnd, `${className}.${methodName} body must stay inside ${className}`);
  return stripComments(source.text.slice(start, bodyEnd + 1));
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

export function objectArrowCallbackCode(source: SourceContract, variableName: string, propertyName: string) {
  const initializer = variableInitializerCode(source, variableName);
  const initializerSource: SourceContract = {
    fileName: `${source.fileName}#${variableName}`,
    text: initializer,
    codeMask: maskNonCode(initializer),
  };
  const objectStart = initializerSource.codeMask.indexOf('{');
  assert.ok(objectStart >= 0, `${variableName} must keep an object argument`);
  const objectEnd = matchingDelimiter(initializerSource.codeMask, objectStart, '{', '}');
  const pattern = new RegExp(`\\b${escapeRegExp(propertyName)}\\s*:\\s*\\(`, 'g');
  const candidates = Array.from(initializerSource.codeMask.matchAll(pattern)).filter((match) => {
    const index = match.index;
    return index > objectStart
      && index < objectEnd
      && braceDepthAt(initializerSource.codeMask, objectStart, index) === 1;
  });
  assert.equal(
    candidates.length,
    1,
    `expected exactly one top-level callback property named ${variableName}.${propertyName} in ${source.fileName}`,
  );

  const start = candidates[0].index;
  const openParen = initializerSource.codeMask.indexOf('(', start);
  const closeParen = matchingDelimiter(initializerSource.codeMask, openParen, '(', ')');
  let arrow = closeParen + 1;
  while (/\s/.test(initializerSource.codeMask[arrow] ?? '')) arrow += 1;
  assert.equal(
    initializerSource.codeMask.slice(arrow, arrow + 2),
    '=>',
    `${variableName}.${propertyName} must remain an arrow callback`,
  );
  let bodyStart = arrow + 2;
  while (/\s/.test(initializerSource.codeMask[bodyStart] ?? '')) bodyStart += 1;
  assert.equal(
    initializerSource.codeMask[bodyStart],
    '{',
    `${variableName}.${propertyName} must keep a block body`,
  );
  const bodyEnd = matchingDelimiter(initializerSource.codeMask, bodyStart, '{', '}');
  assert.ok(bodyEnd < objectEnd, `${variableName}.${propertyName} body must stay inside ${variableName}`);
  return stripComments(initializerSource.text.slice(start, bodyEnd + 1));
}

export function importSources(source: SourceContract) {
  const code = stripComments(source.text);
  const pattern = /^\s*import(?:\s+type)?(?:[\s\S]*?\s+from\s+)?\s*['"]([^'"]+)['"]\s*;?\s*$/gm;
  return Array.from(code.matchAll(pattern), (match) => match[1]);
}

export function sourceCode(source: SourceContract) {
  return stripComments(source.text);
}
