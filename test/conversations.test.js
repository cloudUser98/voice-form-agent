// Live end-to-end tests: real API, real tool loop, scripted text input.
// They are slow and cost cents, which is the point — they test the thing that
// actually ships instead of a mock of it.
import 'dotenv/config';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import visit from '../forms/visit.js';
import hotel from '../forms/hotel.js';
import { converse } from './helpers.js';

const live = { skip: process.env.OPENAI_API_KEY ? false : 'no OPENAI_API_KEY', timeout: 120000 };

describe('visit form', () => {
  test('collects several visitors in one conversation', live, async () => {
    const r = await converse(visit, [
      'Somos Victor Delgado y Ana Ruiz, venimos de FAMSA.',
      'Tenemos junta con Laura Mendoza.',
    ]);
    assert.equal(r.missing.length, 0, `still missing: ${r.missing}`);
    assert.equal(r.data.visitantes.length, 2);
    assert.match(r.data.procedencia, /FAMSA/i);
    assert.match(r.data.anfitrion, /Laura/i);
    assert.ok(r.done, 'should have submitted');
  });

  test('a correction replaces the earlier value', live, async () => {
    const r = await converse(visit, [
      'Soy Pedro Ramirez, vengo de Bimbo a dejar unos documentos.',
      'Perdón, me equivoqué: no vengo de Bimbo, vengo de Lala.',
      'Busco a Carlos Nunez.',
    ]);
    assert.match(r.data.procedencia, /Lala/i);
    assert.doesNotMatch(r.data.procedencia, /Bimbo/i);
  });

  test('prefilled context is used instead of asked for', live, async () => {
    const r = await converse(visit, [
      'Sí, soy yo. Vengo de FAMSA a ver a Laura Mendoza por la junta mensual.',
    ], {
      prefill: { visitantes: ['Víctor Delgado'] },
      notes: 'La cámara reconoció a Víctor Delgado, que ya ha visitado antes.',
    });
    const opening = r.transcript.find((m) => m.role === 'agent')?.text || '';
    assert.match(opening, /V[íi]ctor/i, 'should greet him by name');
    assert.deepEqual(r.data.visitantes, ['Víctor Delgado']);
  });
});

describe('hotel form — same engine, different questions', () => {
  test('fills enums and numbers', live, async () => {
    const r = await converse(hotel, [
      'Buenas noches, soy Marta Solis.',
      'Nos quedamos tres noches, en una suite.',
    ]);
    assert.match(r.data.huesped, /Marta/i);
    assert.equal(r.data.noches, 3);
    assert.equal(r.data.habitacion, 'suite');
    assert.ok(['sencilla', 'doble', 'suite'].includes(r.data.habitacion));
  });
});
