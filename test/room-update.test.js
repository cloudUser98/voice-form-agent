// The agent's side of the room: who exists, when it wakes up, and cutting in
// to acknowledge an arrival. Offline, with a fake socket.
process.env.TRACE = 'off';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import visit from '../forms/visit.js';
import { FormAgent } from '../src/agent.js';

function harness({ ready = true } = {}) {
  const agent = new FormAgent({ form: visit, mode: 'text', apiKey: 'test-key' });
  const sent = [];
  agent.ws = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };
  if (ready) agent.handleEvent({ type: 'session.updated' });
  sent.length = 0;
  return { agent, sent };
}

const person = (over = {}) =>
  ({ origin: 'unknown', personKey: null, label: '', prefill: {}, notes: '', ...over });

const injected = (sent) => sent
  .filter((e) => e.type === 'conversation.item.create' && e.item?.role === 'system')
  .map((e) => e.item.content[0].text);

describe('waking up', () => {
  test('holds no registrations and says nothing until the room reports somebody', () => {
    const { agent, sent } = harness();
    assert.equal(agent.registrations.size, 0);
    assert.equal(sent.filter((e) => e.type === 'response.create').length, 0);
  });

  test('an update that beats the handshake is queued, then applied', () => {
    const { agent, sent } = harness({ ready: false });
    agent.roomUpdate({ arrived: [person({ label: 'Ana Ruiz', origin: 'known' })] });

    assert.equal(agent.registrations.size, 0, 'nothing created before the session is up');
    agent.handleEvent({ type: 'session.updated' });
    assert.equal(agent.registrations.size, 1, 'applied once the session is ready');
    assert.equal(injected(sent).length, 1);
  });

  test('a group arriving together is greeted once, not once each', () => {
    const { agent, sent } = harness();
    agent.roomUpdate({ arrived: [person(), person(), person()] });

    assert.equal(agent.registrations.size, 3);
    const notes = injected(sent);
    assert.equal(notes.length, 1, 'one message for the whole group');
    assert.match(notes[0], /Greet them together/);
    assert.equal(sent.filter((e) => e.type === 'response.create').length, 1);
  });

  test('focus lands on the first person through the door', () => {
    const { agent } = harness();
    agent.roomUpdate({ arrived: [person({ label: 'Ana Ruiz' }), person({ label: 'Beto Cruz' })] });
    assert.equal(agent.focused, 'r1');
  });

  test('prefill from the camera seeds the form', () => {
    const { agent } = harness();
    agent.roomUpdate({ arrived: [person({
      origin: 'known', personKey: 'p_1', label: 'Víctor Dávalos',
      prefill: { visitante: 'Víctor Dávalos', procedencia: 'Dominos' },
    })] });

    const reg = agent.registrations.get('r1');
    assert.equal(reg.state.data.procedencia, 'Dominos');
    assert.equal(reg.state.evidence.procedencia.source, 'prefill');
    assert.equal(reg.origin, 'known');
    assert.equal(reg.personKey, 'p_1');
  });

  test('an empty update says nothing at all', () => {
    const { agent, sent } = harness();
    agent.roomUpdate({});
    assert.equal(sent.length, 0);
  });
});

describe('leaving', () => {
  test('a departure names the registration and asks about continuing', () => {
    const { agent, sent } = harness();
    agent.roomUpdate({ arrived: [person({ label: 'Ana Ruiz', origin: 'known', personKey: 'p_1' })] });
    sent.length = 0;

    agent.roomUpdate({ departed: [agent.registrations.get('r1')] });
    const note = injected(sent)[0];
    assert.match(note, /Ana Ruiz has left/);
    assert.match(note, /r1/);
    assert.match(note, /close_registration/);
  });

  test('an unidentified departure admits the camera cannot say who', () => {
    const { agent, sent } = harness();
    agent.roomUpdate({ arrived: [person(), person()] });
    sent.length = 0;

    agent.roomUpdate({ unidentifiedLeft: 1 });
    assert.match(injected(sent)[0], /cannot say which/);
  });
});

describe('cutting in to acknowledge', () => {
  /** Put the agent mid-sentence with some audio already sent. */
  function speaking(agent, sent, { ms = 1000 } = {}) {
    agent.handleEvent({ type: 'response.created' });
    agent.handleEvent({ type: 'response.output_item.added', item: { id: 'item_1' } });
    const chunk = Buffer.alloc((24000 * 2 * ms) / 1000).toString('base64');
    agent.handleEvent({ type: 'response.output_audio.delta', item_id: 'item_1', delta: chunk });
    sent.length = 0;
  }

  test('truncates before cancelling, so the model knows what was heard', () => {
    const { agent, sent } = harness();
    agent.roomUpdate({ arrived: [person()] });
    speaking(agent, sent);

    agent.roomUpdate({ arrived: [person({ label: 'Ana Ruiz' })] });
    const kinds = sent.map((e) => e.type);
    const cut = kinds.indexOf('conversation.item.truncate');
    const cancel = kinds.indexOf('response.cancel');

    assert.ok(cut >= 0 && cancel >= 0, 'both are sent');
    assert.ok(cut < cancel, 'truncate must come first');
    assert.equal(sent[cut].item_id, 'item_1');
    assert.equal(sent[cut].content_index, 0);
  });

  test('never claims more was heard than was generated', () => {
    const { agent, sent } = harness();
    agent.roomUpdate({ arrived: [person()] });
    speaking(agent, sent, { ms: 40 });          // only 40ms of audio exists

    agent.roomUpdate({ arrived: [person({ label: 'Ana Ruiz' })] });
    const cut = sent.find((e) => e.type === 'conversation.item.truncate');
    assert.ok(cut.audio_end_ms <= 40, `claimed ${cut.audio_end_ms}ms of a 40ms response`);
  });

  test('stale deltas from the cut response are dropped, the next one is not', () => {
    const { agent, sent } = harness();
    agent.roomUpdate({ arrived: [person()] });
    speaking(agent, sent);
    agent.roomUpdate({ arrived: [person({ label: 'Ana Ruiz' })] });

    const heard = [];
    agent.on('audio', (b) => heard.push(b.length));

    // Still in flight from the response we just cut.
    agent.handleEvent({ type: 'response.output_audio.delta', item_id: 'item_1', delta: Buffer.alloc(100).toString('base64') });
    assert.deepEqual(heard, [], 'stale audio would talk over the acknowledgement');

    agent.handleEvent({ type: 'response.output_item.added', item: { id: 'item_2' } });
    agent.handleEvent({ type: 'response.output_audio.delta', item_id: 'item_2', delta: Buffer.alloc(100).toString('base64') });
    assert.deepEqual(heard, [100]);
  });

  test('the acknowledgement turn cannot reach for a tool', () => {
    const { agent, sent } = harness();
    agent.roomUpdate({ arrived: [person()] });
    speaking(agent, sent);

    agent.roomUpdate({ arrived: [person({ label: 'Ana Ruiz' })] });
    const create = sent.find((e) => e.type === 'response.create');
    assert.equal(create.response?.tool_choice, 'none');
    assert.match(injected(sent)[0], /pick up exactly where you left off/);
  });

  test('nothing is truncated when the agent was already silent', () => {
    const { agent, sent } = harness();
    agent.roomUpdate({ arrived: [person()] });
    agent.handleEvent({ type: 'response.done', response: { id: 'r', status: 'completed', output: [] } });
    sent.length = 0;

    agent.roomUpdate({ arrived: [person({ label: 'Ana Ruiz' })] });
    assert.equal(sent.filter((e) => e.type === 'conversation.item.truncate').length, 0);
    assert.equal(sent.find((e) => e.type === 'response.create').response, undefined);
  });
});
