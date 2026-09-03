import assert from 'node:assert/strict';

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Masks comments and string/template contents while preserving byte offsets.
 * Structural scans can then ignore brace-like text without depending on the
 * TypeScript compiler API, which is no longer exported from TypeScript 7's
 * package root.
 */
function maskNonCode(source: string) {
  const masked = source.split('');
  let state: 'code' | 'single' | 'double' | 'template' | 'line-comment' | 'block-comment' = 'code';

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (state === 'code') {
      if (char === '/' && next === '/') {
        masked[i] = ' ';
        masked[i + 1] = ' ';
        state = 'line-comment';
        i += 1;
      } else if (char === '/' && next === '*') {
        masked[i] = ' ';
        masked[i + 1] = ' ';
        state = 'block-comment';
        i += 1;
      } else if (char === "'") {
        masked[i] = ' ';
        state = 'single';
      } else if (char === '"') {
        masked[i] = ' ';
        state = 'double';
      } else if (char === '`') {
        masked[i] = ' ';
        state = 'template';
      }
      continue;
    }

    if (state === 'line-comment') {
      if (char === '\n') state = 'code';
      else masked[i] = ' ';
      continue;
    }

    masked[i] = char === '\n' ? '\n' : ' ';

    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        masked[i + 1] = ' ';
        state = 'code';
        i += 1;
      }
      continue;
    }

    if (char === '\\') {
      if (i + 1 < source.length) {
        masked[i + 1] = source[i + 1] === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }

    if (
      (state === 'single' && char === "'")
      || (state === 'double' && char === '"')
      || (state === 'template' && char === '`')
    ) {
      state = 'code';
    }
  }

  return masked.join('');
}

function depthsBefore(masked: string, end: number) {
  let braces = 0;
  let parens = 0;
  let brackets = 0;
  for (let i = 0; i < end; i += 1) {
    if (masked[i] === '{') braces += 1;
    else if (masked[i] === '}') braces -= 1;
    else if (masked[i] === '(') parens += 1;
    else if (masked[i] === ')') parens -= 1;
    else if (masked[i] === '[') brackets += 1;
    else if (masked[i] === ']') brackets -= 1;
  }
  return { braces, parens, brackets };
}

/**
 * Server declarations live one brace deep inside startRelayServer(). Select the
 * shallowest code match instead of assuming file-global depth zero. Nested
 * callbacks with the same spelling remain deeper and therefore cannot win.
 */
function shallowestCodeMatch(masked: string, pattern: RegExp, description: string) {
  let best: RegExpMatchArray | null = null;
  let bestBraceDepth = Number.POSITIVE_INFINITY;

  for (const match of masked.matchAll(pattern)) {
    const index = match.index;
    if (index === undefined) continue;
    const depths = depthsBefore(masked, index);
    if (depths.parens !== 0 || depths.brackets !== 0) continue;
    if (depths.braces < bestBraceDepth) {
      best = match;
      bestBraceDepth = depths.braces;
    }
  }

  if (best) return best;
  assert.fail(`${description} must remain identifiable`);
}

function matchingDelimiter(masked: string, start: number, open: string, close: string) {
  assert.equal(masked[start], open, `expected ${open} at structural boundary`);
  let depth = 0;
  for (let i = start; i < masked.length; i += 1) {
    if (masked[i] === open) depth += 1;
    else if (masked[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  assert.fail(`unterminated ${open}${close} structural boundary`);
}

function expressionEnd(masked: string, start: number, terminators: ReadonlySet<string>) {
  let braces = 0;
  let parens = 0;
  let brackets = 0;
  for (let i = start; i < masked.length; i += 1) {
    const char = masked[i];
    if (char === '{') braces += 1;
    else if (char === '}') {
      if (braces === 0 && parens === 0 && brackets === 0 && terminators.has('}')) return i;
      braces -= 1;
    } else if (char === '(') parens += 1;
    else if (char === ')') parens -= 1;
    else if (char === '[') brackets += 1;
    else if (char === ']') brackets -= 1;
    else if (braces === 0 && parens === 0 && brackets === 0 && terminators.has(char)) return i;
  }
  return masked.length;
}

/** Returns one complete function declaration from the shallowest matching scope. */
export function topLevelFunctionSource(source: string, name: string) {
  const masked = maskNonCode(source);
  const match = shallowestCodeMatch(
    masked,
    new RegExp(`\\bfunction\\s+${escapeRegExp(name)}\\s*\\(`, 'g'),
    `function ${name}`,
  );
  const start = match.index!;
  const paramsOpen = masked.indexOf('(', start);
  const paramsClose = matchingDelimiter(masked, paramsOpen, '(', ')');
  const bodyOpen = masked.indexOf('{', paramsClose + 1);
  assert.ok(bodyOpen >= 0, `function ${name} must retain a body`);
  const bodyClose = matchingDelimiter(masked, bodyOpen, '{', '}');
  return source.slice(start, bodyClose + 1);
}

/** Returns the complete initializer from the shallowest matching declaration scope. */
export function topLevelInitializerSource(source: string, name: string) {
  const masked = maskNonCode(source);
  const match = shallowestCodeMatch(
    masked,
    new RegExp(`\\b(?:const|let|var)\\s+${escapeRegExp(name)}\\s*=`, 'g'),
    `variable ${name}`,
  );
  let start = match.index! + match[0].length;
  while (/\s/.test(masked[start] ?? '')) start += 1;
  const end = expressionEnd(masked, start, new Set([';']));
  assert.ok(end > start, `variable ${name} must retain an initializer`);
  return source.slice(start, end).trimEnd();
}

/**
 * Returns one property from the object literal passed to a named composition
 * call. The member ends at its own structural comma, not a guessed next
 * property name.
 */
export function callObjectPropertySource(source: string, variableName: string, property: string) {
  const initializer = topLevelInitializerSource(source, variableName);
  const masked = maskNonCode(initializer);
  const objectOpen = masked.indexOf('{');
  assert.ok(objectOpen >= 0, `${variableName} must keep an object-literal composition argument`);
  const objectClose = matchingDelimiter(masked, objectOpen, '{', '}');
  const propertyPattern = new RegExp(`\\b${escapeRegExp(property)}\\s*:`, 'g');

  for (const match of masked.matchAll(propertyPattern)) {
    const start = match.index;
    if (start === undefined || start <= objectOpen || start >= objectClose) continue;
    const depth = depthsBefore(masked.slice(objectOpen + 1, objectClose), start - objectOpen - 1).braces;
    if (depth !== 0) continue;
    const colon = masked.indexOf(':', start);
    let valueStart = colon + 1;
    while (/\s/.test(masked[valueStart] ?? '')) valueStart += 1;
    const end = expressionEnd(masked, valueStart, new Set([',', '}']));
    return initializer.slice(start, end).trimEnd();
  }

  assert.fail(`${variableName}.${property} must remain identifiable`);
}
