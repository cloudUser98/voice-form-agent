// Several people, one conversation. The offline half drives the tool loop by
// hand; the live half is the one that matters — it asks whether one person's
// answer lands on another person's form.
process.env.TRACE = 'off';

import 'dotenv/config';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import visit from '../forms/visit.js';
import { FormAgent } from '../src/agent.js';
import { converse } from './helpers.js';
import { stubHosts } from './hosts-stub.js';

// visit's `anfitrion` is checked against the staff directory. Offline, that
// directory is this list.
stubHosts();

const live ={ skip: process.env.OPENAI_API_KEY ? false : 'no OPENAI_API_KEY', timeout: 120000 };

/** An agent with a fake socket, so tool results are readable without a network. */
function harness({ arrive = [''], ...opts } = {}) {
  const agent = new FormAgent({ form: visit, mode: 'text', apiKey: 'test-key', ...opts });
  const sent = [];
  agent.ws = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };
  agent.handleEvent({ type: 'session.updated' });

  // Registrations only exist because the room says a person does.
  if (arrive.length) agent.roomUpdate({ arrived: arrive.map((label) => ({
    origin: label ? 'known' : 'unknown', personKey: label || null,
    label: label || '', prefill: {}, notes: '',
  })) });

  let n = 0;
  const call = async (name, args = {}) => {
    sent.length = 0;
    agent.handleEvent({
      type: 'response.done',
      response: {
        id: `resp_${++n}`, status: 'completed',
        output: [{ type: 'function_call', name, call_id: `c${n}`, arguments: JSON.stringify(args) }],
      },
    });
    await new Promise((r) => setTimeout(r, 10));      // the tool loop is async
    const out = sent.find((e) => e.item?.type === 'function_call_output');
    return out ? JSON.parse(out.item.output) : null;
  };

  return { agent, call, sent };
}

const FULL = { visitante: 'Víctor Dávalos', procedencia: 'Dominos', motivo: 'entrega', anfitrion: 'Amalia' };

describe('registrations', () => {
  test('somebody walking in is what creates r1', () => {
    const { agent } = harness();
    assert.deepEqual([...agent.registrations.keys()], ['r1']);
  });

  test('a second arrival opens r2', () => {
    const { agent } = harness({ arrive: ['', 'Ana Ruiz'] });
    assert.equal(agent.registrations.size, 2);
    assert.equal(agent.registrations.get('r2').label, 'Ana Ruiz');
  });

  test('a missing id falls back to the only open registration', async () => {
    const { agent, call } = harness();
    const r = await call('save_fields', { fields: { procedencia: 'Dominos' } });
    assert.equal(r.registration, 'r1');
    assert.equal(agent.registrations.get('r1').state.data.procedencia, 'Dominos');
  });

  test('a wrong id is refused and the valid ones are offered back', async () => {
    const { call } = harness({ arrive: ['', 'Ana Ruiz'] });
    const r = await call('save_fields', { registration: 'r9', fields: { procedencia: 'Lala' } });
    assert.equal(r.ok, false);
    assert.deepEqual(r.valid.map((v) => v.id), ['r1', 'r2']);
  });

  test('each registration keeps its own values', async () => {
    const { agent, call } = harness({ arrive: ['', 'Ana Ruiz'] });
    await call('save_fields', { registration: 'r1', fields: { procedencia: 'Dominos' } });
    await call('save_fields', { registration: 'r2', fields: { procedencia: 'Lala' } });

    assert.equal(agent.registrations.get('r1').state.data.procedencia, 'Dominos');
    assert.equal(agent.registrations.get('r2').state.data.procedencia, 'Lala');
  });

  test('the board names a registration from labelFrom once it is known', async () => {
    const { agent, call } = harness();
    await call('save_fields', { registration: 'r1', fields: { visitante: 'Víctor Dávalos' } });
    const r = await call('open_registrations');
    assert.equal(r.registrations[0].label, 'Víctor Dávalos');
  });

  test('open_registrations reports what each person still needs', async () => {
    const { call } = harness({ arrive: ['', 'Ana Ruiz'] });
    await call('save_fields', { registration: 'r1', fields: FULL });
    const r = await call('open_registrations');

    assert.deepEqual(r.registrations.find((x) => x.id === 'r1').missing, []);
    assert.ok(r.registrations.find((x) => x.id === 'r2').missing.length > 0);
  });

  test('a closed registration stops being the fallback', async () => {
    const { agent, call } = harness({ arrive: ['', 'Ana Ruiz'] });
    await call('close_registration', { registration: 'r1', reason: 'se fue' });
    assert.equal(agent.registrations.get('r1').status, 'closed');

    const r = await call('save_fields', { fields: { procedencia: 'Lala' } });
    assert.equal(r.registration, 'r2', 'the only OPEN one should take it');
  });

  test('maxOpen caps how many people can be registering at once', () => {
    const { agent } = harness({ maxOpen: 2, arrive: ['', 'Ana', 'Beto', 'Caro'] });
    assert.equal(agent.registrations.size, 2);
  });

  test('the completion beat is tracked per registration', async () => {
    const { agent, call } = harness({ arrive: ['', 'Ana Ruiz'] });
    await call('save_fields', { registration: 'r1', fields: FULL });

    assert.equal(agent.registrations.get('r1').beatDone, true);
    assert.equal(agent.registrations.get('r2').beatDone, false);
  });

  test('a correction targets the registration it was given', async () => {
    const { agent, call } = harness({ arrive: ['', 'Ana Ruiz'] });
    await call('save_fields', { registration: 'r1', fields: { procedencia: 'Dominos' } });

    assert.deepEqual(agent.correct('procedencia', 'Grupo Lala', 'r2'), { ok: true });
    assert.equal(agent.registrations.get('r1').state.data.procedencia, 'Dominos');
    assert.equal(agent.registrations.get('r2').state.data.procedencia, 'Grupo Lala');
  });
});

describe('two people in the room', () => {
  test('a newcomer gets their own registration', live, async () => {
    const r = await converse(visit, [
      'Soy Víctor Dávalos, vengo de Dominos.',
      (agent) => agent.roomUpdate({ arrived: [{ origin: 'known', personKey: 'p_ana', label: 'Ana Ruiz', prefill: {}, notes: '' }] }),
      'Buenas tardes, soy Ana Ruiz.',
      'Vengo a una junta.',
    ]);
    assert.ok(Object.keys(r.registrations).length >= 2,
      `expected two registrations, got ${JSON.stringify(Object.keys(r.registrations))}`);
  });

  // The failure this whole stage risks: an unprompted answer from the person
  // the agent is NOT talking to, landing on the wrong form.
  test('an interjection does not overwrite the other person\'s answer', live, async () => {
    const r = await converse(visit, [
      'Soy Víctor Dávalos, vengo de Dominos.',
      (agent) => agent.roomUpdate({ arrived: [{ origin: 'known', personKey: 'p_ana', label: 'Ana Ruiz', prefill: {}, notes: '' }] }),
      'Perdón, yo soy Ana Ruiz y vengo de Lala.',   // Ana, unprompted, clearly not Víctor
      'Sigo yo: vengo a entregar un paquete.',  // Víctor again
    ]);
    const r1 = r.registrations.r1;
    assert.ok(r1, 'r1 should still exist');
    assert.match(r1.data.procedencia || '', /Dominos/i,
      `Ana's company leaked onto Víctor's form: ${JSON.stringify(r1.data)}`);
  });
});
