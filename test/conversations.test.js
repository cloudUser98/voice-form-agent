// Live end-to-end tests: real API, real tool loop, scripted text input.
// They are slow and cost cents, which is the point — they test the thing that
// actually ships instead of a mock of it.
import 'dotenv/config';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import visit from '../forms/visit.js';
import hotel from '../forms/hotel.js';
import { hosts } from '../forms/api.js';
import { converse } from './helpers.js';

const live = { skip: process.env.OPENAI_API_KEY ? false : 'no OPENAI_API_KEY', timeout: 120000 };

describe('visit form', () => {
  // Superseded by Stage B: one form is now one person, so two visitors means
  // two registrations. Re-enable as a multi-registration test then.
  test('collects several visitors in one conversation', { ...live, skip: 'rewritten in Stage B' }, async () => {
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

  // The one field the agent is not allowed to take the visitor's word for.
  // Whoever the directory actually holds is read from it, so this test does not
  // depend on a name being seeded there by hand.
  test('a host who is not in the directory is asked for again', live, async () => {
    const [known] = await hosts();
    const r = await converse(visit, [
      'Soy Ana Ruiz, vengo de Bimbo a una junta.',
      'Vengo a ver a Rodrigo Salinas Quintanilla.',        // nobody
      `Ah, perdón, me equivoqué: es ${known}.`,
    ]);
    assert.match(r.data.anfitrion || '', new RegExp(known.split(' ')[0], 'i'),
      'only a name the directory knows may stick');
    assert.doesNotMatch(r.data.anfitrion || '', /Rodrigo/i);
  });

  test('prefilled context is used instead of asked for', live, async () => {
    const r = await converse(visit, [
      'Sí, soy yo. Vengo de FAMSA a ver a Laura Mendoza por la junta mensual.',
    ], {
      prefill: { visitante: 'Víctor Delgado' },
      label: 'Víctor Delgado',
      notes: 'La cámara reconoció a Víctor Delgado, que ya ha visitado antes.',
    });
    const opening = r.transcript.find((m) => m.role === 'agent')?.text || '';
    assert.match(opening, /V[íi]ctor/i, 'should greet him by name');
    assert.equal(r.data.visitante, 'Víctor Delgado');
  });
});

describe('catching and fixing a wrong value', () => {
  test('every saved value carries the words it came from', live, async () => {
    const r = await converse(visit, [
      'Soy Ana Ruiz, vengo de Bimbo a dejar unos papeles con Carlos Nunez.',
    ]);
    for (const field of Object.keys(r.data)) {
      const ev = r.evidence[field];
      assert.ok(ev, `${field} has no provenance`);
      assert.ok(['heard', 'inferred', 'prefill', 'corrected', 'client'].includes(ev.source));
      if (ev.source === 'heard') assert.ok(ev.heard?.length, `${field} claims 'heard' with no quote`);
    }
    // Anything genuinely spoken should be quoted, so a human can check it.
    assert.equal(r.evidence.procedencia.source, 'heard');
    assert.match(r.evidence.procedencia.heard, /Bimbo/i);
  });

  test('a staff correction overrules the agent without derailing it', live, async () => {
    const r = await converse(visit, [
      'Soy Ana Ruiz y vengo de Bimbo.',
      (agent) => {
        assert.deepEqual(agent.correct('procedencia', 'X'), { ok: false, error: 'procedencia: too short' });
        assert.equal(agent.correct('nope', 'y').ok, false);
        assert.deepEqual(agent.correct('procedencia', 'Grupo Lala'), { ok: true });
      },
      'Oye, ¿de qué empresa me registraste?',
    ]);
    assert.equal(r.data.procedencia, 'Grupo Lala');
    assert.equal(r.evidence.procedencia.source, 'corrected');

    // It should adopt the new value and not narrate the correction.
    const said = r.transcript.filter((m) => m.role === 'agent').map((m) => m.text).join(' ');
    assert.match(said, /Lala/i);
    assert.doesNotMatch(said, /corrigi|correcci[óo]n|compañer|sistema me indic/i);
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
