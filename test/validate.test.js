// Fast, offline, no API key needed.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch, missingFields, isEmpty } from '../src/validate.js';

const schema = {
  type: 'object',
  required: ['nombre', 'noches'],
  properties: {
    nombre: { type: 'string', minLength: 2 },
    noches: { type: 'integer', minimum: 1, maximum: 60 },
    tipo: { type: 'string', enum: ['sencilla', 'suite'] },
    invitados: { type: 'array', items: { type: 'string', minLength: 2 } },
  },
};

describe('validate', () => {
  test('empty values never count as filled', () => {
    for (const v of [undefined, null, '', '   ', []]) assert.equal(isEmpty(v), true);
    for (const v of [0, false, 'a', ['a']]) assert.equal(isEmpty(v), false);
  });

  test('reports what is still required', () => {
    assert.deepEqual(missingFields(schema, {}), ['nombre', 'noches']);
    assert.deepEqual(missingFields(schema, { nombre: 'Ana', noches: 2 }), []);
  });

  test('accepts a valid partial patch', () => {
    const data = {};
    const r = applyPatch(schema, data, { nombre: 'Ana Ruiz' });
    assert.deepEqual(r.changed, ['nombre']);
    assert.equal(r.problems.length, 0);
    assert.equal(data.nombre, 'Ana Ruiz');
  });

  test('rejects bad values with a reason and keeps the rest', () => {
    const data = {};
    const r = applyPatch(schema, data, { nombre: 'Ana', noches: 99, tipo: 'penthouse' });
    assert.equal(data.nombre, 'Ana');
    assert.equal(data.noches, undefined);
    assert.equal(r.problems.length, 2);
    assert.match(r.problems.join(' '), /at most 60/);
    assert.match(r.problems.join(' '), /one of: sencilla, suite/);
  });

  test('rejects unknown fields', () => {
    const r = applyPatch(schema, {}, { color: 'azul' });
    assert.match(r.problems[0], /not a field/);
  });

  test('validates inside lists', () => {
    const ok = applyPatch(schema, {}, { invitados: ['Ana', 'Luis'] });
    assert.equal(ok.problems.length, 0);
    const bad = applyPatch(schema, {}, { invitados: ['Ana', 'X'] });
    assert.match(bad.problems[0], /invitados\[1\]/);
  });

  test('a later patch overwrites an earlier value', () => {
    const data = { nombre: 'Ana' };
    applyPatch(schema, data, { nombre: 'Ana Ruiz' });
    assert.equal(data.nombre, 'Ana Ruiz');
  });
});
