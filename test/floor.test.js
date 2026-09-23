// Who gets to speak next. Only one response may be in flight, so everything
// else that wants the floor waits — and a forced turn must wait with what it
// was going to say, not just the fact that it wanted to say something. Offline:
// the server is played by hand, one event at a time.
process.env.TRACE = 'off';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FormAgent } from '../src/agent.js';
import { blocking } from '../src/tools.js';

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** A promise you settle by hand. */
function controllable() {
  let settle;
  const fn = () => new Promise((res) => { settle = res; });
  return { fn, resolve: (v) => settle(v) };
}

const USER = {
  key: 'id',
  properties: {
    id: { type: 'string' },
    nombre: { type: 'string', prefill: true, confirmOnly: true, beforeUpdate: 'RENAMES-THEIR-PROFILE' },
  },
};

/** A small form whose only tool is a slow one that fills fields. */
function makeForm(lookup, over = {}) {
  return {
    name: 'floor-test',
    persona: 'You are a receptionist.',
    onComplete: false,
    labelFrom: 'nombre',
    schema: {
      type: 'object',
      required: ['nombre', 'motivo'],
      properties: { nombre: { type: 'string' }, motivo: { type: 'string' } },
    },
    user: USER,
    tools: [{
      definition: { type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } },
      run: blocking(lookup, { say: 'COVER-SENTENCE', coverAfterMs: 5 }),
    }],
    submit: async () => ({ folio: 'F-1' }),
    ...over,
  };
}

function harness(form, { record = { id: 'K1', nombre: 'Luis' } } = {}) {
  const agent = new FormAgent({ form, mode: 'text', apiKey: 'test-key' });
  const sent = [];
  agent.realTimeWs = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };
  agent.handleEvent({ type: 'session.updated' });
  if (record) agent.arrive(record);
  else agent.roomUpdate({ arrived: [{ origin: 'unknown', personKey: null, label: '', prefill: {}, notes: '' }] });
  // The greeting that arrival asked for has been spoken.
  agent.handleEvent({ type: 'response.created', response: { id: 'resp_greet' } });
  agent.handleEvent({ type: 'response.done', response: { id: 'resp_greet', status: 'completed', output: [] } });
  sent.length = 0;

  let n = 0;
  /** The model calls a tool. Not awaited: a blocking tool is still running. */
  const fire = (name, args = {}) => {
    const id = `resp_call_${++n}`;
    agent.handleEvent({ type: 'response.created', response: { id } });
    agent.handleEvent({
      type: 'response.done',
      response: {
        id, status: 'completed',
        output: [{ type: 'function_call', name, call_id: `c${n}`, arguments: JSON.stringify(args) }],
      },
    });
  };
  /** The response that was asked for last starts, and later finishes saying nothing. */
  const starts = (id) => agent.handleEvent({ type: 'response.created', response: { id } });
  const ends = (id) => agent.handleEvent({ type: 'response.done', response: { id, status: 'completed', output: [] } });
  const creates = () => sent.filter((e) => e.type === 'response.create');

  return { agent, sent, fire, starts, ends, creates };
}

describe('a forced turn asked for while the floor is taken', () => {
  test('the proposal waits behind the cover sentence, and keeps its words', async () => {
    const net = controllable();
    const { agent, fire, starts, ends, creates } = harness(makeForm(net.fn));

    fire('lookup', { registration: 'r1' });
    await tick();
    assert.match(creates()[0]?.response?.instructions || '', /COVER-SENTENCE/, 'the cover went out');
    starts('resp_cover');

    // The code is read: it carries somebody else's name.
    net.resolve({ ok: true, fields: { nombre: 'Fernando Gómez' } });
    await tick();
    assert.equal(creates().length, 1, 'nothing else may start while the cover is in flight');
    assert.equal(agent.registrations.get('r1').proposals.get('nombre')?.asked, true);

    ends('resp_cover');
    const beat = creates()[1]?.response;
    assert.ok(beat, 'once the cover is done, the waiting turn goes out');
    assert.equal(beat.tool_choice, 'none', 'still a forced turn, not a plain one');
    assert.match(beat.instructions, /RENAMES-THEIR-PROFILE/, 'with the reason it was built to give');
    assert.match(beat.instructions, /"Luis" to "Fernando Gómez"/);
  });

  test('the read-back waits behind the cover sentence too', async () => {
    const net = controllable();
    const { fire, starts, ends, creates } = harness(
      makeForm(net.fn, { onComplete: 'read-back' }), { record: null });

    fire('lookup', { registration: 'r1' });
    await tick();
    starts('resp_cover');
    net.resolve({ ok: true, fields: { nombre: 'Ana Ruiz', motivo: 'junta' } });
    await tick();

    ends('resp_cover');
    const beat = creates()[1]?.response;
    assert.equal(beat?.tool_choice, 'none');
    assert.match(beat.instructions, /NOT yet submitted/);
    assert.match(beat.instructions, /Ana Ruiz/);
  });

  test('the handover waits behind a slow submit\'s cover sentence', async () => {
    const net = controllable();
    const form = makeForm(async () => ({ ok: true }), {
      submit: blocking(net.fn, { say: 'COVER-SENTENCE', coverAfterMs: 5 }),
    });
    const { agent, fire, starts, ends, creates } = harness(form, { record: null });
    agent.roomUpdate({ arrived: [{ origin: 'known', personKey: 'p2', label: 'Ana', prefill: {}, notes: '' }] });
    ends('resp_room');
    const already = creates().length;

    fire('save_fields', { registration: 'r1', fields: { nombre: 'Luis', motivo: 'junta' } });
    await tick();
    ends('resp_after_save');
    fire('submit_form', { registration: 'r1' });
    await tick();
    starts('resp_cover');
    net.resolve({ folio: 'F-2' });
    await tick();

    ends('resp_cover');
    const beat = creates().at(-1)?.response;
    assert.ok(creates().length > already);
    assert.equal(beat?.tool_choice, 'none');
    assert.match(beat.instructions, /Say goodbye to them in ONE short sentence, then turn to Ana/);
  });

  test('an interjection goes first, and does not swallow the waiting turn', async () => {
    const net = controllable();
    const { agent, sent, fire, starts, ends, creates } = harness(makeForm(net.fn));

    fire('lookup', { registration: 'r1' });
    await tick();
    starts('resp_cover');
    net.resolve({ ok: true, fields: { nombre: 'Fernando Gómez' } });
    await tick();

    // Somebody walks in while the cover is still being spoken.
    agent.roomUpdate({ arrived: [{ origin: 'known', personKey: 'p2', label: 'Ana', prefill: {}, notes: '' }] });
    assert.ok(sent.some((e) => e.type === 'response.cancel'), 'the cover is cut off');
    assert.equal(creates().length, 2);
    assert.doesNotMatch(creates()[1].response.instructions || '', /RENAMES-THEIR-PROFILE/,
      'the acknowledgement comes first');

    // The cut cover finishes after the interjection has asked for the floor. That
    // is not the floor coming free: sending now would be two responses at once.
    ends('resp_cover');
    assert.equal(creates().length, 2, 'a response we cut off does not free the floor');

    starts('resp_ack');
    ends('resp_ack');
    const beat = creates()[2]?.response;
    assert.match(beat?.instructions || '', /RENAMES-THEIR-PROFILE/, 'then the change is explained');
  });

  test('two plain requests while busy still make one response', () => {
    const { agent, starts, ends, creates } = harness(makeForm(async () => ({})), { record: null });
    agent.sendText('hola');
    starts('resp_1');
    agent.sendText('¿me oyes?');
    agent.sendText('¿hola?');
    assert.equal(creates().length, 1);
    ends('resp_1');
    assert.equal(creates().length, 2);
    assert.equal(creates()[1].response, undefined, 'a plain turn');
    starts('resp_2');
    ends('resp_2');
    assert.equal(creates().length, 2, 'and only one');
  });
});
