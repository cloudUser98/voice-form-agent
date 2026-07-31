// Finishing with one person while others are still waiting. The failure this
// covers: the agent said goodbye and stopped, and a visitor had to prompt it.
process.env.TRACE = 'off';

import 'dotenv/config';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import visit from '../forms/visit.js';
import { FormAgent } from '../src/agent.js';
import { FormState } from '../src/form-state.js';
import { buildBoard } from '../src/prompt.js';
import { converse } from './helpers.js';

const live = { skip: process.env.OPENAI_API_KEY ? false : 'no OPENAI_API_KEY', timeout: 120000 };
const FULL = { visitante: 'Víctor Dávalos', procedencia: 'Dominos', motivo: 'entrega', anfitrion: 'Amalia' };

function harness({ arrive = ['', 'Ana Ruiz'] } = {}) {
  const agent = new FormAgent({ form: visit, mode: 'text', apiKey: 'test-key' });
  const sent = [];
  agent.ws = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };
  agent.handleEvent({ type: 'session.updated' });
  agent.roomUpdate({ arrived: arrive.map((label) => ({
    origin: label ? 'known' : 'unknown', personKey: label || null,
    label: label || '', prefill: {}, notes: '',
  })) });

  let n = 0;
  const call = async (...batch) => {
    sent.length = 0;
    agent.handleEvent({
      type: 'response.done',
      response: {
        id: `resp_${++n}`, status: 'completed',
        output: batch.map(([name, args], i) => ({
          type: 'function_call', name, call_id: `c${n}_${i}`, arguments: JSON.stringify(args || {}),
        })),
      },
    });
    await new Promise((r) => setTimeout(r, 15));
    return sent.find((e) => e.type === 'response.create');
  };
  return { agent, call, sent };
}

describe('handing over to whoever is next', () => {
  test('submitting r1 moves focus to r2', async () => {
    const { agent, call } = harness();
    await call(['save_fields', { registration: 'r1', fields: FULL }]);
    await call(['submit_form', { registration: 'r1' }]);
    assert.equal(agent.focused, 'r2');
  });

  test('submitting the last one leaves focus where it is', async () => {
    const { agent, call } = harness({ arrive: [''] });
    await call(['save_fields', { registration: 'r1', fields: FULL }]);
    await call(['submit_form', { registration: 'r1' }]);
    assert.equal(agent.focused, 'r1');
  });

  test('closing hands over the same way submitting does', async () => {
    const { agent, call } = harness();
    await call(['close_registration', { registration: 'r1', reason: 'se fue' }]);
    assert.equal(agent.focused, 'r2');
  });

  test('finishing one with another waiting forces a spoken handover', async () => {
    const { call } = harness();
    await call(['save_fields', { registration: 'r1', fields: FULL }]);
    const create = await call(['submit_form', { registration: 'r1' }]);

    assert.equal(create.response?.tool_choice, 'none', 'it must speak, not reach for a tool');
    const said = create.response.instructions;
    assert.match(said, /Ana Ruiz/, 'names who is next');
    assert.match(said, /visitante|procedencia/, 'names something concrete to ask for');
  });

  // Otherwise the agent turns to an empty room and keeps talking.
  test('finishing the last one forces nothing', async () => {
    const { call } = harness({ arrive: [''] });
    await call(['save_fields', { registration: 'r1', fields: FULL }]);
    const create = await call(['submit_form', { registration: 'r1' }]);
    assert.equal(create.response, undefined, 'no forced beat with nobody waiting');
  });

  test('if the next person is already complete, hand over to their confirmation', async () => {
    const { agent, call } = harness();
    await call(
      ['save_fields', { registration: 'r1', fields: FULL }],
      ['save_fields', { registration: 'r2', fields: { ...FULL, visitante: 'Ana Ruiz' } }],
    );
    const create = await call(['submit_form', { registration: 'r1' }]);

    assert.match(create.response.instructions, /Repeat the recorded details back/);
    assert.equal(agent.registrations.get('r2').beatDone, true, 'so it is not read back twice');
  });
});

describe('the board stops contradicting the handover', () => {
  const entry = (id, label, data, status) => {
    const state = new FormState(visit.schema);
    state.save(data);
    return { id, label, state, status, result: status === 'submitted' ? { folio: 'V-1' } : null, focused: false };
  };

  test('a finished registration no longer tells the agent to stop', () => {
    const board = buildBoard(visit, [
      entry('r1', 'Víctor', FULL, 'submitted'),
      entry('r2', 'Ana', {}, 'open'),
    ]);
    assert.doesNotMatch(board, /Say goodbye/, 'this is what stranded Ana');
    assert.match(board, /r2 \(Ana\) is still waiting/);
  });

  test('it still says stop once nobody is left', () => {
    const board = buildBoard(visit, [entry('r1', 'Víctor', FULL, 'submitted')]);
    assert.match(board, /Everyone has been dealt with/);
    assert.match(board, /call no tool/);
  });

  test('an abandoned registration stops advertising fields it wants', () => {
    const board = buildBoard(visit, [entry('r1', 'Víctor', {}, 'closed')]);
    assert.match(board, /CLOSED/);
    assert.doesNotMatch(board, /missing:/);
  });
});

describe('live', () => {
  test('it turns to the next person without being asked', live, async () => {
    const r = await converse(visit, [
      (agent) => agent.roomUpdate({ arrived: [
        { origin: 'known', personKey: 'p_v', label: 'Víctor Dávalos', prefill: {}, notes: '' },
      ] }),
      'Soy Víctor Dávalos, vengo de Dominos a entregar un paquete a Amalia Gastelum.',
      'Sí, todo correcto.',
    ]);

    // After Víctor is submitted the agent must address the other visitor itself.
    const said = r.transcript.filter((m) => m.role === 'agent').map((m) => m.text).join(' ');
    assert.ok(r.done, 'Víctor should have been submitted');
    assert.match(said, /\?/, 'it should still be asking somebody something');
  });
});
