export function pascalCase(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');
}

export function camelCase(s: string): string {
  const p = pascalCase(s);
  return p ? p[0].toLowerCase() + p.slice(1) : p;
}

export function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export function setterName(name: string): string {
  return `set${cap(name)}`;
}

export const GLOBALS = new Set([
  'Math', 'JSON', 'Date', 'Number', 'String', 'Object', 'Array', 'Boolean', 'parseInt',
  'parseFloat', 'isNaN', 'undefined', 'null', 'window', 'document', 'console', 'Promise',
  'Infinity', 'NaN', 'encodeURIComponent', 'decodeURIComponent', 'Symbol', 'Map', 'Set',
  'localStorage', 'sessionStorage', 'navigator', 'location', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'fetch', 'alert', 'confirm',
]);
