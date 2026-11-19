/**
 * Lint/formatação sem dependências (VF-4-05). Verifica, em js/, tests/, scripts/ e na raiz:
 *  - sintaxe (`node --check`) de todo .js/.mjs;
 *  - sem tabs, sem espaços ao fim da linha, arquivo termina com uma única quebra de linha;
 *  - `console.log`, `debugger`, `eval(`, marcadores de merge e `.only(` proibidos;
 *  - imports nomeados não usados;
 *  - JSON válido (package.json, firebase.json, firestore.indexes.json, vercel.json).
 * Uso: `npm run lint` — sai com código 1 se houver problemas.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.git', '.firebase', 'emulator-data', 'coverage', 'assets']);
const problems = [];
const report = (file, line, message) => problems.push(`${relative(root, file)}${line ? `:${line}` : ''} — ${message}`);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Nomes importados via `import { a, b as c } from` / `import x from` / `import * as x`. */
export function importedNames(source) {
  const names = [];
  const re = /^import\s+(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\}|\*\s+as\s+([\w$]+))?\s*from\s*['"][^'"]+['"]/gm;
  for (const m of source.matchAll(re)) {
    if (m[1]) names.push(m[1]);
    if (m[3]) names.push(m[3]);
    if (m[2]) {
      for (const part of m[2].split(',')) {
        const piece = part.trim();
        if (!piece) continue;
        names.push(piece.includes(' as ') ? piece.split(/\s+as\s+/)[1].trim() : piece);
      }
    }
  }
  return names;
}

/** Remove comentários e strings para a busca de uso (aproximação suficiente para imports). */
function stripNoise(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/import\s[^;]*?from\s*['"][^'"]+['"];?/g, ' ');
}

/** Arquivos com fixtures de código ruim (ex.: testes do próprio lint) usam esta marca nas 5 primeiras linhas. */
const DISABLE_MARK = 'lint-disable-file';

export function lintSource(file, source) {
  if (source.split('\n', 5).some((l) => l.includes(DISABLE_MARK))) return [];
  const found = [];
  const lines = source.split('\n');
  lines.forEach((line, i) => {
    if (/\t/.test(line)) found.push([i + 1, 'tab (use espaços)']);
    if (/[ \t]+$/.test(line.replace(/\r$/, ''))) found.push([i + 1, 'espaço ao fim da linha']);
    if (/^(<{7}|={7}|>{7})( |$)/.test(line)) found.push([i + 1, 'marcador de merge']);
    if (/\bconsole\.log\(/.test(line) && !/^\s*(\/\/|\*)/.test(line)) found.push([i + 1, 'console.log (use console.info/warn/error)']);
    if (/^\s*debugger\b/.test(line)) found.push([i + 1, 'debugger']);
    if (/\beval\(/.test(line) && !/^\s*(\/\/|\*)/.test(line)) found.push([i + 1, 'eval']);
    if (/\b(describe|it|test)\.only\(/.test(line)) found.push([i + 1, '.only() esquecido']);
  });
  if (source.length && !source.endsWith('\n')) found.push([lines.length, 'arquivo sem quebra de linha final']);
  if (source.endsWith('\n\n')) found.push([lines.length, 'mais de uma quebra de linha final']);
  const body = stripNoise(source);
  for (const name of importedNames(source)) {
    if (!new RegExp(`(^|[^\\w$.]|\\.\\.\\.)${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(body)) {
      found.push([0, `import não usado: ${name}`]);
    }
  }
  return found.map(([line, message]) => ({ file, line, message }));
}

function main() {
  for (const file of walk(root)) {
    const ext = extname(file);
    if (ext === '.js' || ext === '.mjs') {
      const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (check.status !== 0) report(file, 0, `erro de sintaxe: ${(check.stderr || '').split('\n').find((l) => l.includes('Error')) ?? 'node --check falhou'}`);
      for (const p of lintSource(file, readFileSync(file, 'utf8'))) report(p.file, p.line, p.message);
    } else if (ext === '.json' && !file.endsWith('package-lock.json')) {
      try { JSON.parse(readFileSync(file, 'utf8')); } catch (error) { report(file, 0, `JSON inválido: ${error.message}`); }
    }
  }

  if (problems.length) {
    console.error(`lint: ${problems.length} problema(s)\n${problems.join('\n')}`);
    process.exit(1);
  }
  console.info('lint: OK');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
