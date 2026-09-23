// The cover sentence — "un momento" while a blocking tool works. It is only
// worth saying if the visitor would otherwise sit in silence, and it is worth
// nothing once the tool is done. Offline: the server and the network are both
// played by hand, so every timing case is exact.
process.env.TRACE = 'off';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FormAgent } from '../src/agent.js';
import { blocking } from '../src/tools.js';

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const pcm = (ms) => Buffer.alloc((24000 * 2 * ms) / 1000).toString('base64');

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

function makeForm(lookup, { coverAfterMs = 5 } = {}) {
  return {
    name: 'cover-test',
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
      run: blocking(lookup, { say: 'COVER-SENTENCE', coverAfterMs }),
    }],
    submit: async () => ({ folio: 'F-1' }),
  };
}

function harness(form) {
  const agent = new FormAgent({ form, mode: 'audio', apiKey: 'test-key' });
  const sent = [];
  const heard = [];
  const said = [];
  const errors = [];
  agent.realTimeWs = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };
  agent.on('audio', (b) => heard.push(b.length));
  agent.on('transcript', (t) => t.role === 'agent' && said.push(t.text));
  agent.on('error', (e) => errors.push(e));
  agent.handleEvent({ type: 'session.updated' });
  agent.arrive({ id: 'K1', nombre: 'Luis' });
  agent.handleEvent({ type: 'response.created', response: { id: 'resp_greet' } });
  agent.handleEvent({ type: 'response.done', response: { id: 'resp_greet', status: 'completed', output: [] } });
  sent.length = 0;

  /**
   * The model says something and calls the tool in the same response. `spoken`
   * is how much audio that sentence was — the visitor is still hearing it when
   * the tool starts.
   */
  const call = ({ spoken = 0 } = {}) => {
    agent.handleEvent({ type: 'response.created', response: { id: 'resp_call' } });
    if (spoken) {
      agent.handleEvent({ type: 'response.output_item.added', response_id: 'resp_call', item: { id: 'item_call' } });
      agent.handleEvent({ type: 'response.output_audio.delta', response_id: 'resp_call', item_id: 'item_call', delta: pcm(spoken) });
    }
    agent.handleEvent({
      type: 'response.done',
      response: {
        id: 'resp_call', status: 'completed',
        output: [{ type: 'function_call', name: 'lookup', call_id: 'c1', arguments: '{"registration":"r1"}' }],
      },
    });
  };
  const creates = () => sent.filter((e) => e.type === 'response.create');
  const cancels = () => sent.filter((e) => e.type === 'response.cancel');
  /** The cover finishes, cancelled or not, with the one item it had begun. */
  const coverDone = (status) => agent.handleEvent({
    type: 'response.done',
    response: {
      id: 'resp_cover', status,
      output: [{ id: 'item_cover', type: 'message', role: 'assistant', content: [{ type: 'output_audio', transcript: 'Un mom' }] }],
    },
  });

  return { agent, sent, heard, said, errors, call, creates, cancels, coverDone };
}

describe('a cover nobody has heard yet is taken back', () => {
  test('the tool finishes before the cover makes a sound: it is cancelled and never heard', async () => {
    const net = controllable();
    const { agent, sent, heard, said, call, creates, cancels, coverDone } = harness(makeForm(net.fn));

    call();
    await tick();
    assert.match(creates()[0]?.response?.instructions || '', /COVER-SENTENCE/, 'the cover was asked for');
    agent.handleEvent({ type: 'response.created', response: { id: 'resp_cover' } });

    net.resolve({ ok: true });                   // the code is read ~0.5s in
    await tick();
    assert.deepEqual(cancels(), [{ type: 'response.cancel', response_id: 'resp_cover' }]);

    // Audio the server had already generated arrives after the cancel.
    agent.handleEvent({ type: 'response.output_item.added', response_id: 'resp_cover', item: { id: 'item_cover' } });
    agent.handleEvent({ type: 'response.output_audio.delta', response_id: 'resp_cover', item_id: 'item_cover', delta: pcm(200) });
    assert.deepEqual(heard, [], 'the avatar is never given a byte of it');

    const before = creates().length;
    coverDone('cancelled');
    assert.ok(sent.some((e) => e.type === 'conversation.item.delete' && e.item_id === 'item_cover'),
      'the model is not left believing it said it');
    assert.deepEqual(said, [], 'nor is it shown as said');
    assert.equal(creates().length, before + 1, 'and the model gets the floor back for the result');
  });

  test('withdrawn before the server even named it: cancelled the moment it does', async () => {
    const net = controllable();
    const { agent, call, cancels } = harness(makeForm(net.fn));

    call();
    await tick();
    net.resolve({ ok: true });
    await tick();
    assert.equal(cancels().length, 0, 'nothing to cancel yet');

    agent.handleEvent({ type: 'response.created', response: { id: 'resp_cover' } });
    assert.deepEqual(cancels(), [{ type: 'response.cancel', response_id: 'resp_cover' }]);
  });

  test('a cover already being heard is left to finish', async () => {
    const net = controllable();
    const { agent, heard, call, cancels, coverDone, said } = harness(makeForm(net.fn));

    call();
    await tick();
    agent.handleEvent({ type: 'response.created', response: { id: 'resp_cover' } });
    agent.handleEvent({ type: 'response.output_item.added', response_id: 'resp_cover', item: { id: 'item_cover' } });
    agent.handleEvent({ type: 'response.output_audio.delta', response_id: 'resp_cover', item_id: 'item_cover', delta: pcm(100) });

    net.resolve({ ok: true });
    await tick();
    assert.equal(cancels().length, 0, 'never cut a sentence off mid-word');
    agent.handleEvent({ type: 'response.output_audio.delta', response_id: 'resp_cover', item_id: 'item_cover', delta: pcm(100) });
    assert.equal(heard.length, 2);
    coverDone('completed');
    assert.deepEqual(said, ['Un mom']);
  });

  test('a proposal waiting behind a withdrawn cover still gets its forced turn', async () => {
    const net = controllable();
    const { agent, call, creates, coverDone } = harness(makeForm(net.fn));

    call();
    await tick();
    agent.handleEvent({ type: 'response.created', response: { id: 'resp_cover' } });
    net.resolve({ ok: true, fields: { nombre: 'Fernando Gómez' } });
    await tick();

    coverDone('cancelled');
    const beat = creates().at(-1).response;
    assert.equal(beat?.tool_choice, 'none');
    assert.match(beat.instructions, /RENAMES-THEIR-PROFILE/);
  });

  test('cancelling one that had just finished is not an error anybody hears about', () => {
    const { agent, errors } = harness(makeForm(async () => ({})));
    agent.handleEvent({
      type: 'error',
      error: { type: 'invalid_request_error', code: 'response_cancel_not_active', message: 'no active response' },
    });
    assert.equal(errors.length, 0);
    agent.handleEvent({ type: 'error', error: { message: 'something real' } });
    assert.equal(errors.length, 1);
  });
});

describe('the wait is the silence, not the tool', () => {
  test('a tool that finishes while the visitor is still hearing the sentence that called it is never covered', async () => {
    const net = controllable();
    const { call, creates } = harness(makeForm(net.fn, { coverAfterMs: 50 }));

    call({ spoken: 1000 });                      // "Dame un momento para…", a second of audio
    await tick(300);
    assert.equal(creates().length, 0, 'they are still listening to the agent; there is no silence to cover');

    net.resolve({ ok: true });
    await tick();
    assert.ok(creates().every((c) => !/COVER-SENTENCE/.test(c.response?.instructions || '')));
  });

  test('once that sentence has played out, a tool still running is covered', async () => {
    const net = controllable();
    const { call, creates } = harness(makeForm(net.fn, { coverAfterMs: 20 }));

    call({ spoken: 100 });
    await tick(200);
    assert.match(creates()[0]?.response?.instructions || '', /COVER-SENTENCE/);
    net.resolve({ ok: true });
    await tick();
  });
});
