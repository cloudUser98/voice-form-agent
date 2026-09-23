// A change to somebody's profile needs their yes, and a yes has to have been
// SAID. The model reports what the visitor answered; the engine checks that
// report against what was transcribed after the question was put to them.
// Offline except the one `live` block at the end.
process.env.TRACE = 'off';

import 'dotenv/config';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FormAgent } from '../src/agent.js';
import { grounded } from '../src/user.js';
import visit from '../forms/visit.js';
import visitor from '../users/visitor.js';
import { converse, withoutClient } from './helpers.js';

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const USER = {
  key: 'id',
  properties: {
    id: { type: 'string' },
    nombre: { type: 'string', prefill: true, confirmOnly: true, beforeUpdate: 'RENAMES-THEIR-PROFILE' },
    documento: { type: 'string', prefill: true, readOnly: true },
  },
};

const FORM = {
  name: 'confirmation-test',
  persona: 'You are a receptionist.',
  onComplete: false,
  labelFrom: 'nombre',
  schema: {
    type: 'object',
    required: ['nombre', 'motivo'],
    properties: { nombre: { type: 'string' }, documento: { type: 'string' }, motivo: { type: 'string' } },
  },
  user: USER,
  submit: async () => ({ folio: 'F-1' }),
};

const ANA = { id: 'K-ana', nombre: 'Ana Sofía Ruiz', documento: 'INE-1' };

function harness({ mode = 'audio', form = FORM, record = ANA } = {}) {
  const agent = new FormAgent({ form, mode, apiKey: 'test-key' });
  agent.hearingBudgetMs = 150;                  // offline, a missing transcript is quick to give up on
  const sent = [];
  agent.realTimeWs = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };
  agent.handleEvent({ type: 'session.updated' });
  agent.arrive(record);

  let n = 0;
  let items = 0;
  /** The visitor speaks: the turn is committed now, its words land `late` ms later. */
  const say = (text, { late = 0, lost = false } = {}) => {
    if (mode === 'text') return agent.sendText(text);
    const item = `item_user_${++items}`;
    agent.handleEvent({ type: 'input_audio_buffer.committed', item_id: item });
    if (lost) return;
    const land = () => agent.handleEvent({
      type: 'conversation.item.input_audio_transcription.completed', item_id: item, transcript: text,
    });
    if (late) setTimeout(land, late); else land();
  };
  /** The model calls a tool; resolves with what the tool answered. */
  const call = async (name, args = {}, wait = 20) => {
    sent.length = 0;
    agent.handleEvent({
      type: 'response.done',
      response: {
        id: `resp_${++n}`, status: 'completed',
        output: [{ type: 'function_call', name, call_id: `c${n}`, arguments: JSON.stringify(args) }],
      },
    });
    await tick(wait);
    const out = sent.find((e) => e.item?.type === 'function_call_output');
    return out ? JSON.parse(out.item.output) : null;
  };
  const reg = () => agent.registrations.get('r1');
  const nextResponse = () => sent.filter((e) => e.type === 'response.create').at(-1);
  const board = () => sent.filter((e) => e.type === 'session.update').at(-1)?.session.instructions || '';

  return { agent, say, call, reg, nextResponse, board, sent };
}

/** The visitor asks for the change, and the engine parks it. */
async function propose(h) {
  h.say('No traigo código. Por favor, regístrenme como Ana Sofía Ruiz Carranza.');
  const r = await h.call('save_fields', {
    registration: 'r1', fields: { nombre: 'Ana Sofía Ruiz Carranza' }, quotes: { nombre: 'Ana Sofía Ruiz Carranza' },
  });
  assert.deepEqual(r.pending_confirmation, ['nombre']);
}

describe('a yes nobody said', () => {
  // The case from the kiosk, word for word (trace 3413f363).
  test('an answer that is not a yes, and a quote the model made up: nothing is written', async () => {
    const h = harness();
    await propose(h);
    h.say('Vengo del despacho Ruiz y Asociados, con Roberto Sánchez. ¿Ya puedo pasar?');
    const r = await h.call('confirm_change', {
      registration: 'r1', field: 'nombre', accept: true,
      quote: 'Sí, regístrenme como Ana Sofía Ruiz Carranza, por favor.',
    });

    assert.equal(r.ok, false);
    assert.match(r.error, /have not said yes/);
    assert.deepEqual(r.heard, ['Vengo del despacho Ruiz y Asociados, con Roberto Sánchez. ¿Ya puedo pasar?'],
      'the model is shown what was actually said');
    assert.deepEqual(r.pending_confirmation, ['nombre']);
    assert.equal(h.reg().state.data.nombre, 'Ana Sofía Ruiz', 'the profile\'s value stands');
    assert.equal(h.reg().state.evidence.nombre.source, 'prefill');
    assert.ok(h.reg().proposals.has('nombre'), 'the question is still open');
  });

  test('after a refusal the question is asked again, forced, and briefly', async () => {
    const h = harness();
    await propose(h);
    h.say('¿Ya puedo pasar?');
    await h.call('confirm_change', { registration: 'r1', field: 'nombre', accept: true, quote: 'Sí.' });

    const beat = h.nextResponse()?.response;
    assert.equal(beat?.tool_choice, 'none', 'a forced turn, so it cannot be skipped');
    assert.match(beat.instructions, /has NOT answered/);
    assert.match(beat.instructions, /"Ana Sofía Ruiz" to "Ana Sofía Ruiz Carranza"/);
    assert.match(beat.instructions, /do not repeat the whole explanation/);
  });

  test('then a real yes goes through, and the screen shows what they really said', async () => {
    const h = harness();
    await propose(h);
    h.say('¿Ya puedo pasar?');
    await h.call('confirm_change', { registration: 'r1', field: 'nombre', accept: true, quote: 'Sí.' });
    h.say('Sí, cámbienlo por favor.');
    const r = await h.call('confirm_change', {
      registration: 'r1', field: 'nombre', accept: true, quote: 'Sí, cámbienlo, por favor',
    });

    assert.equal(r.ok, true);
    assert.deepEqual(r.saved, ['nombre']);
    assert.equal(h.reg().state.data.nombre, 'Ana Sofía Ruiz Carranza');
    assert.equal(h.reg().state.evidence.nombre.confirmed, true);
    assert.equal(h.reg().state.evidence.nombre.confirmedWith, 'Sí, cámbienlo por favor.',
      'the transcript, not the model\'s version of it');
  });

  test('the sentence that asked for the change is not an answer to it', async () => {
    const h = harness();
    await propose(h);
    h.say('Vengo a una junta.');
    const r = await h.call('confirm_change', {
      registration: 'r1', field: 'nombre', accept: true,
      quote: 'Por favor, regístrenme como Ana Sofía Ruiz Carranza.',
    });
    assert.equal(r.ok, false);
    assert.equal(h.reg().state.data.nombre, 'Ana Sofía Ruiz');
  });

  test('nothing said at all since the question is not a yes', async () => {
    const h = harness();
    await propose(h);
    const r = await h.call('confirm_change', { registration: 'r1', field: 'nombre', accept: true, quote: 'Sí' });
    assert.equal(r.ok, false);
    assert.match(r.error, /have not answered/);
  });

  test('no quote is no evidence', async () => {
    const h = harness();
    await propose(h);
    h.say('Sí.');
    const r = await h.call('confirm_change', { registration: 'r1', field: 'nombre', accept: true });
    assert.equal(r.ok, false);
  });

  test('a no is taken without checking — keeping the profile is the safe answer', async () => {
    const h = harness();
    await propose(h);
    const r = await h.call('confirm_change', { registration: 'r1', field: 'nombre', accept: false, quote: 'lo que sea' });
    assert.equal(r.ok, true);
    assert.equal(h.reg().proposals.size, 0);
    assert.equal(h.reg().state.data.nombre, 'Ana Sofía Ruiz');
  });
});

describe('the words arrive when they arrive', () => {
  test('a transcription that lands after the tool call is waited for', async () => {
    const h = harness();
    await propose(h);
    h.say('Sí, adelante.', { late: 60 });        // the model answered before the transcriber did
    const r = await h.call('confirm_change',
      { registration: 'r1', field: 'nombre', accept: true, quote: 'Sí, adelante' }, 120);
    assert.equal(r.ok, true);
    assert.equal(h.reg().state.data.nombre, 'Ana Sofía Ruiz Carranza');
  });

  test('one that never lands is not waited for forever, and is not a yes', async () => {
    const h = harness();
    await propose(h);
    h.say('Sí, adelante.', { lost: true });
    const r = await h.call('confirm_change',
      { registration: 'r1', field: 'nombre', accept: true, quote: 'Sí, adelante' }, 250);
    assert.equal(r?.ok, false);
  });

  test('a failed transcription counts as nothing said', async () => {
    const h = harness();
    await propose(h);
    h.agent.handleEvent({ type: 'input_audio_buffer.committed', item_id: 'item_x' });
    h.agent.handleEvent({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'item_x' });
    const r = await h.call('confirm_change', { registration: 'r1', field: 'nombre', accept: true, quote: 'Sí' });
    assert.equal(r.ok, false);
  });

  test('a transcription naming an item nobody committed still counts', async () => {
    const h = harness();
    await propose(h);
    h.agent.handleEvent({
      type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_unknown', transcript: 'Sí, claro.',
    });
    const r = await h.call('confirm_change', { registration: 'r1', field: 'nombre', accept: true, quote: 'Sí, claro' });
    assert.equal(r.ok, true);
  });

  test('typed input is checked the same way', async () => {
    const h = harness({ mode: 'text' });
    await propose(h);
    h.say('¿Ya puedo pasar?');
    const invented = await h.call('confirm_change', { registration: 'r1', field: 'nombre', accept: true, quote: 'Sí' });
    assert.equal(invented.ok, false);
    h.say('Sí, por favor.');
    const real = await h.call('confirm_change', { registration: 'r1', field: 'nombre', accept: true, quote: 'sí por favor' });
    assert.equal(real.ok, true);
  });

  test('a tool that brings back somebody else\'s name is answered the same way', async () => {
    const form = {
      ...FORM,
      tools: [{
        definition: { type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } },
        run: async () => ({ ok: true, fields: { nombre: 'Fernando Gómez' } }),
      }],
    };
    const h = harness({ form });
    h.say('Sí, aquí está mi código.');
    const r = await h.call('lookup', { registration: 'r1' });
    assert.deepEqual(r.pending_confirmation, ['nombre']);
    const c = await h.call('confirm_change',
      { registration: 'r1', field: 'nombre', accept: true, quote: 'Sí, aquí está mi código' });
    assert.equal(c.ok, false, 'a yes to the code question is not a yes to the new name');
  });
});

describe('grounded', () => {
  test('ignores accents, capitals and punctuation', () => {
    assert.ok(grounded('Sí, que lo cambien, por favor.', 'si que lo cambien por favor'));
    assert.ok(grounded('SÍ', '¡Sí!'));
  });

  test('finds the words inside a longer answer', () => {
    assert.ok(grounded('sí, cámbialo', 'Mmm, sí, cámbialo, y vengo con Roberto.'));
  });

  test('a longer quote may miss one word in five', () => {
    assert.ok(grounded('Sí, que lo cambien por favor', 'Sí, lo cambien por favor'));   // 5 of 6
    assert.ok(grounded('Sí, que lo cambien por favor', 'Sí, que me lo cambien, por favor'));
    assert.ok(!grounded('Sí, que lo cambien por favor', 'Sí, que cambien'));
  });

  test('a short quote must be there whole', () => {
    assert.ok(!grounded('sí, claro', 'claro que no'));
    assert.ok(!grounded('sí', 'no sé'));
  });

  test('somebody else\'s sentence is not grounded', () => {
    assert.ok(!grounded('Sí, regístrenme como Ana Sofía Ruiz Carranza, por favor.',
      'Vengo del despacho Ruiz y Asociados, con Roberto Sánchez. ¿Ya puedo pasar?'));
  });

  test('nothing is never grounded', () => {
    assert.ok(!grounded('', 'sí'));
    assert.ok(!grounded(undefined, 'sí'));
    assert.ok(!grounded('sí', ''));
  });
});

// ---------------------------------------------------------------------------
// Live: the kiosk's case in text mode. Whatever the model does with an answer
// that is not a yes, the name must still be the profile's after it — and a
// real yes afterwards must still go through.

const live = { skip: process.env.OPENAI_API_KEY ? false : 'no OPENAI_API_KEY', timeout: 180000 };

describe('live: the visitor does not answer the question', () => {
  test('nothing changes until they say yes, then it does', live, async () => {
    const knownVisit = { ...withoutClient(visit), user: visitor, submit: async () => ({ folio: 'TEST' }) };
    let beforeYes;
    const r = await converse(knownVisit, [
      'Hola, buenos días. Por favor, regístrenme como Ana Sofía Ruiz Carranza.',
      'Vengo del despacho Ruiz y Asociados, con Amalia Gastelum. ¿Ya puedo pasar?',
      (agent) => { beforeYes = agent.registrations.get('r1').state.data.visitante; },
      'Sí, cámbienlo por favor.',
      'Vengo a una reunión de seguimiento.',
      'Sí, todo correcto.',
      'Sí.',
    ], { user: { persona_id: 'p_ana', visitante: 'Ana Sofía Ruiz', procedencia: 'Despacho Ruiz y Asociados' }, timeoutMs: 170000 });

    assert.equal(beforeYes, 'Ana Sofía Ruiz', 'an answer that is not a yes changed their name');
    assert.equal(r.data.visitante, 'Ana Sofía Ruiz Carranza');
    assert.equal(r.evidence.visitante?.confirmed, true);
    assert.match(r.evidence.visitante?.confirmedWith || '', /cámbienlo/);
  });
});
