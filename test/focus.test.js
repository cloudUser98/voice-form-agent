// Focus, shared gaps and cross-attribution. All offline — none of this needs
// the model to cooperate, which is the point: the agent chooses freely, and
// these mechanics record what it chose.
process.env.TRACE = 'off';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import visit from '../forms/visit.js';
import { FormAgent } from '../src/agent.js';
import { FormState } from '../src/form-state.js';
import { buildBoard } from '../src/prompt.js';

function harness(opts = {}) {
  const agent = new FormAgent({ form: visit, mode: 'text', apiKey: 'test-key', ...opts });
  agent.ws = { readyState: 1, send: () => {} };
  let n = 0;
  const call = async (name, args = {}) => {
    const sent = [];
    agent.ws = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };
    agent.handleEvent({
      type: 'response.done',
      response: {
        id: `resp_${++n}`, status: 'completed',
        output: [{ type: 'function_call', name, call_id: `c${n}`, arguments: JSON.stringify(args) }],
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    const out = sent.find((e) => e.item?.type === 'function_call_output');
    return out ? JSON.parse(out.item.output) : null;
  };
  return { agent, call };
}

describe('focus', () => {
  test('starts on r1 without anyone asking', () => {
    const { agent } = harness();
    assert.equal(agent.focused, 'r1');
  });

  test('focus moves it and reports what that person needs', async () => {
    const { agent, call } = harness();
    await call('start_registration', { label: 'Ana Ruiz' });
    const r = await call('focus', { registration: 'r2' });

    assert.equal(agent.focused, 'r2');
    assert.equal(r.label, 'Ana Ruiz');
    assert.ok(r.missing.includes('procedencia'));
  });

  test('an unknown registration cannot steal focus', async () => {
    const { agent, call } = harness();
    const r = await call('focus', { registration: 'r7' });
    assert.equal(r.ok, false);
    assert.equal(agent.focused, 'r1');
  });

  test('a save without an id goes to whoever is focused', async () => {
    const { agent, call } = harness();
    await call('start_registration', { label: 'Ana Ruiz' });
    await call('focus', { registration: 'r2' });
    const r = await call('save_fields', { fields: { procedencia: 'Lala' } });

    assert.equal(r.registration, 'r2');
    assert.equal(agent.registrations.get('r1').state.data.procedencia, undefined);
  });

  test('closing the focused registration moves focus to another open one', async () => {
    const { agent, call } = harness();
    await call('start_registration', { label: 'Ana Ruiz' });
    await call('close_registration', { registration: 'r1', reason: 'se fue' });
    assert.equal(agent.focused, 'r2');
  });
});

describe('cross-attribution', () => {
  test('saving to the focused person is not flagged', async () => {
    const { agent, call } = harness();
    await call('save_fields', { registration: 'r1', fields: { procedencia: 'Dominos' }, quotes: { procedencia: 'vengo de Dominos' } });
    const ev = agent.registrations.get('r1').state.evidence.procedencia;

    assert.equal(ev.source, 'heard');
    assert.equal(ev.cross, undefined);
  });

  test('saving to someone else records who was being addressed', async () => {
    const { agent, call } = harness();
    await call('start_registration', { label: 'Ana Ruiz' });
    await call('focus', { registration: 'r2' });
    // Agent is talking to Ana but writes onto Víctor's form.
    await call('save_fields', { registration: 'r1', fields: { procedencia: 'Lala' }, quotes: { procedencia: 'vengo de Lala' } });

    const ev = agent.registrations.get('r1').state.evidence.procedencia;
    assert.equal(ev.cross, 'Ana Ruiz');
    assert.equal(ev.source, 'heard', 'the value is still accepted, only flagged');
    assert.equal(agent.registrations.get('r1').state.data.procedencia, 'Lala');
  });

  test('a shared answer saved to both people flags only the off-focus one', async () => {
    const { agent, call } = harness();
    await call('save_fields', { registration: 'r1', fields: { visitante: 'Víctor Dávalos' } });
    await call('start_registration', { label: 'Ana Ruiz' });
    // One spoken answer, written to both people; focus never left Víctor.
    await call('save_fields', { registration: 'r1', fields: { motivo: 'junta' } });
    await call('save_fields', { registration: 'r2', fields: { motivo: 'junta' } });

    assert.equal(agent.registrations.get('r1').state.evidence.motivo.cross, undefined);
    assert.equal(agent.registrations.get('r2').state.evidence.motivo.cross, 'Víctor Dávalos');
  });
});

describe('shared gaps on the board', () => {
  const entry = (id, label, data, focused = false) => {
    const state = new FormState(visit.schema);
    state.save(data);
    return { id, label, state, status: 'open', focused };
  };

  test('says nothing when only one person is registering', () => {
    const board = buildBoard(visit, [entry('r1', 'Víctor', { visitante: 'Víctor' }, true)]);
    assert.doesNotMatch(board, /ALL still need/);
  });

  test('lists what everybody is still missing', () => {
    const board = buildBoard(visit, [
      entry('r1', 'Víctor', { visitante: 'Víctor', procedencia: 'Dominos' }, true),
      entry('r2', 'Ana', { visitante: 'Ana', procedencia: 'Lala' }),
    ]);
    assert.match(board, /r1 and r2 ALL still need: motivo, anfitrion/);
    assert.match(board, /ask the group once/);
  });

  test('only reports gaps that are genuinely common', () => {
    const board = buildBoard(visit, [
      entry('r1', 'Víctor', { visitante: 'Víctor', procedencia: 'Dominos', motivo: 'junta' }, true),
      entry('r2', 'Ana', { visitante: 'Ana' }),
    ]);
    assert.match(board, /ALL still need: anfitrion/);
    assert.doesNotMatch(board, /ALL still need:.*motivo/);
  });

  test('marks who is being addressed', () => {
    const board = buildBoard(visit, [
      entry('r1', 'Víctor', { visitante: 'Víctor' }),
      entry('r2', 'Ana', { visitante: 'Ana' }, true),
    ]);
    assert.match(board, /▶ r2 Ana/);
    assert.doesNotMatch(board, /▶ r1/);
  });
});
