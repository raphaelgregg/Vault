/** Testes do lint sem dependências (VF-4-05) — lint-disable-file: contém fixtures de código ruim. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lintSource, importedNames } from '../../scripts/lint.mjs';

const messages = (src) => lintSource('x.js', src).map((p) => p.message);

describe('lint — importedNames', () => {
  it('extrai default, nomeados com alias e namespace', () => {
    assert.deepEqual(importedNames("import a, { b, c as d } from 'x';\nimport * as ns from 'y';"), ['a', 'b', 'd', 'ns']);
    assert.deepEqual(importedNames("import {\n  one,\n  two,\n} from './m.js';"), ['one', 'two']);
  });
});

describe('lint — regras', () => {
  it('aceita código limpo (incluindo spread de import)', () => {
    assert.deepEqual(messages("import { a, b } from 'x';\nexport const v = { ...a(), b };\n"), []);
  });
  it('detecta import não usado, mas não confunde com comentário/string de outra coisa', () => {
    assert.deepEqual(messages("import { used, unused } from 'x';\nused();\n"), ['import não usado: unused']);
    assert.deepEqual(messages("import { a } from 'x';\n// a\nexport {};\n"), ['import não usado: a']);
    assert.deepEqual(messages("import { a } from 'x';\nobj.a();\n"), ['import não usado: a']);
  });
  it('detecta tab, espaço ao fim, console.log, debugger, eval, .only e merge', () => {
    const src = ['\tx', 'y ', 'console.log(1);', 'debugger;', 'eval("1");', "it.only('a', () => {});", '<<<<<<< HEAD', ''].join('\n');
    const found = messages(src);
    for (const expected of ['tab (use espaços)', 'espaço ao fim da linha', 'debugger', 'eval', '.only() esquecido', 'marcador de merge']) {
      assert.ok(found.includes(expected), expected);
    }
    assert.ok(found.some((m) => m.startsWith('console.log')));
  });
  it('exige quebra de linha final única', () => {
    assert.ok(messages('a;').includes('arquivo sem quebra de linha final'));
    assert.ok(messages('a;\n\n').includes('mais de uma quebra de linha final'));
    assert.deepEqual(messages('a;\n'), []);
  });
  it('respeita a marca de arquivo desabilitado', () => {
    assert.deepEqual(messages('// lint-disable-file\nconsole.log(1);\t\n'), []);
  });
  it('ignora console.log em comentário', () => {
    assert.deepEqual(messages('// console.log(1)\n * console.log(2)\n'), []);
  });
});
