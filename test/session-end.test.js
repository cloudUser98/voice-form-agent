// The receptionist goes off duty. Once the last person in the room has been
// registered there is no work left, so the agent says goodbye and closes its
// session — a kiosk facing an empty lobby should hold nothing open.
//
// The failure this covers: the agent finished the last registration and sat
// there indefinitely on a live realtime socket, waiting to be spoken to.
process.env.TRACE = 'off';

import 'dotenv/config';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import visit from '../forms/visit.js';
import { FormAgent } from '../src/agent.js';
import { blocking } from '../src/tools.js';
import { fill, withoutClient } from './helpers.js';
import { stubHosts } from './hosts-stub.js';

stubHosts();

// Handover, session end and id resolution have no opinion about cameras, so
// they run against a visit with nothing for the client to capture. What
// 'complete' means then comes from the schema, not from a literal.
const form = withoutClient(visit);
const FULL = fill(form);
const tick = () => new Promise((r) => setTimeout(r, 15));

function harness({ arrive = [''], form: using = form } = {}) {
  const agent = new FormAgent({ form: using, mode: 'text', apiKey: 'test-key' });
  const sent = [];
  const events = [];
  agent.ws = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };
  for (const name of ['ended', 'idle']) agent.on(name, (p) => events.push({ name, ...p }));
  agent.handleEvent({ type: 'session.updated' });
  agent.roomUpdate({ arrived: arrive.map((label) => ({
    origin: label ? 'known' : 'unknown', personKey: label || null,
    label: label || '', prefill: {}, notes: '',
  })) });

  let n = 0;
  // One model turn that calls tools.
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
    await tick();
    return sent.find((e) => e.type === 'response.create');
  };

  // One model turn that only speaks — what a forced beat produces.
  const speak = async (text = 'Hasta luego, que tenga buen día.') => {
    sent.length = 0;
    agent.handleEvent({ type: 'response.created' });
    agent.handleEvent({
      type: 'response.done',
      response: {
        id: `resp_${++n}`, status: 'completed',
        output: [{ type: 'message', content: [{ type: 'text', text }] }],
      },
    });
    await tick();
    return sent.find((e) => e.type === 'response.create');
  };

  return { agent, call, speak, sent, events };
}

describe('ending the session when the room is empty', () => {
  test('the last submission is followed by a goodbye, then the session ends', async () => {
    const { agent, call, speak, events } = harness();
    await call(['save_fields', { registration: 'r1', fields: FULL }]);

    const create = await call(['submit_form', { registration: 'r1' }]);
    assert.equal(create.response?.tool_choice, 'none', 'the goodbye is forced, not suggested');
    assert.equal(agent.ending, true, 'the session is on its way out');
    assert.equal(agent.ended, false, 'but not before the goodbye has been said');

    await speak();
    assert.equal(agent.ended, true);
    assert.ok(events.some((e) => e.name === 'ended'), "it emits 'ended'");
    assert.equal(events.at(-1).session, agent.sessionId, 'and says which session it was');
  });

  test('the goodbye turn ends the session instead of going idle', async () => {
    // 'idle' means "your turn, say something". There is nobody left to say it.
    const { call, speak, events } = harness();
    await call(['save_fields', { registration: 'r1', fields: FULL }]);
    await call(['submit_form', { registration: 'r1' }]);
    await speak();

    const after = events.map((e) => e.name);
    assert.ok(!after.includes('idle'), 'it must not hand the floor back to an empty room');
  });

  test('an abandoned last registration ends the session without speaking', async () => {
    // close_registration means the person walked off. Nobody is there to hear it.
    const { agent, call, events } = harness();
    const create = await call(['close_registration', { registration: 'r1', reason: 'se fue' }]);

    assert.equal(create, undefined, 'no goodbye to an empty lobby');
    await tick();
    assert.equal(agent.ended, true, 'but the session still ends');
    assert.ok(events.some((e) => e.name === 'ended'));
  });

  test('it does not end while somebody is still waiting', async () => {
    const { agent, call, events } = harness({ arrive: ['', 'Ana Ruiz'] });
    await call(['save_fields', { registration: 'r1', fields: FULL }]);
    await call(['submit_form', { registration: 'r1' }]);

    assert.equal(agent.ending, false, 'Ana has not been registered yet');
    assert.ok(!events.some((e) => e.name === 'ended'));
  });

  test('the goodbye is only ever asked for once', async () => {
    const { agent, call, speak } = harness();
    await call(['save_fields', { registration: 'r1', fields: FULL }]);
    await call(['submit_form', { registration: 'r1' }]);
    assert.equal(agent.farewellDone, true);

    // A second response arriving after the farewell must close, not re-greet.
    const again = await speak();
    assert.equal(again, undefined, 'nothing further is requested');
  });

  test('somebody arriving mid-goodbye does not revive the session', async () => {
    // They belong to the next agent, which the server builds when this closes.
    const { agent, call, speak } = harness();
    await call(['save_fields', { registration: 'r1', fields: FULL }]);
    await call(['submit_form', { registration: 'r1' }]);

    agent.roomUpdate({ arrived: [{ origin: 'known', personKey: 'p_ana', label: 'Ana Ruiz', prefill: {}, notes: '' }] });
    assert.equal(agent.registrations.size, 1, 'no registration is opened on a dying session');

    await speak();
    assert.equal(agent.ended, true);
  });
});

describe('the goodbye waits for the floor', () => {
  // A slow submit covers its own wait with "un momento". That response is still
  // in flight when the form comes back submitted, so a farewell requested right
  // then gets queued behind it and dropped — the session would close on the
  // cover sentence, and the last thing the visitor hears is "one moment".
  test('a slow submit does not swallow it', async () => {
    let release;
    const slow = blocking(() => new Promise((r) => { release = () => r({ folio: 'V-9' }); }),
      { say: 'Di que estás guardando.', coverAfterMs: 5 });

    const { agent, call, speak, sent } = harness({ form: { ...form, submit: slow } });
    await call(['save_fields', { registration: 'r1', fields: FULL }]);

    sent.length = 0;
    const submitting = call(['submit_form', { registration: 'r1' }]);
    await tick();                                   // the cover sentence goes out
    const cover = sent.find((e) => e.type === 'response.create');
    assert.match(cover.response.instructions, /Di que estás guardando/);

    release();
    await submitting;
    await tick();                                   // the submit resolves, r1 lands
    assert.equal(agent.ending, true, 'the last person is done');
    assert.equal(agent.farewellDone, false, 'but the floor is taken');
    assert.ok(agent.pendingFarewell, 'so the goodbye is held, not dropped');

    // The cover sentence finishes and frees the floor.
    const bye = await speak('Un momento.');
    assert.equal(bye?.response?.tool_choice, 'none', 'now the goodbye gets its turn');
    assert.match(bye.response.instructions, /Say goodbye/);
    assert.equal(agent.ended, false, 'and the session is still open to say it');

    await speak();
    assert.equal(agent.ended, true);
  });
});

describe('waiting for the goodbye to actually be heard', () => {
  // response.done means "finished generating", not "finished playing" — the
  // server outruns the speaker. Closing on it clips the last words off.
  test('it waits out the audio it streamed before closing', async () => {
    const { agent, call } = harness();
    await call(['save_fields', { registration: 'r1', fields: FULL }]);
    await call(['submit_form', { registration: 'r1' }]);

    // 0.5s of pcm16 mono @24k, delivered instantly the way the API does.
    const halfSecond = Buffer.alloc(24000 * 2 / 2).toString('base64');
    agent.handleEvent({ type: 'response.created' });
    agent.handleEvent({ type: 'response.output_item.added', item: { id: 'item_1' } });
    agent.handleEvent({ type: 'response.output_audio.delta', item_id: 'item_1', delta: halfSecond });

    const closedAt = new Promise((r) => agent.once('ended', () => r(Date.now())));
    const doneAt = Date.now();
    agent.handleEvent({ type: 'response.done', response: { id: 'r_bye', status: 'completed', output: [] } });

    const waited = (await closedAt) - doneAt;
    assert.ok(waited > 400, `it should hold the socket open for the tail, waited ${waited}ms`);
  });

  test('text mode has no audio to wait for', async () => {
    const { agent, call, speak } = harness();
    await call(['save_fields', { registration: 'r1', fields: FULL }]);
    await call(['submit_form', { registration: 'r1' }]);

    const at = Date.now();
    await speak();
    assert.ok(Date.now() - at < 100, 'nothing was spoken, so nothing is waited for');
    assert.equal(agent.ended, true);
  });
});
