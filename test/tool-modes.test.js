// Tools that reach out to the internet. Offline: the "network" is a promise
// this file resolves by hand, so every timing case is exact.
process.env.TRACE = 'off';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import visit from '../forms/visit.js';
import { FormAgent } from '../src/agent.js';
import { blocking, deferred, background, modeOf, withTimeout } from '../src/tools.js';

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** A promise you resolve when you feel like it, plus a call counter. */
function controllable() {
  let settle, fail, calls = 0;
  const fn = () => { calls += 1; return new Promise((res, rej) => { settle = res; fail = rej; }); };
  return { fn, resolve: (v) => settle(v), reject: (e) => fail(e), get calls() { return calls; } };
}

function harness(form) {
  const agent = new FormAgent({ form, mode: 'text', apiKey: 'test-key' });
  const sent = [];
  agent.ws = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };
  agent.handleEvent({ type: 'session.updated' });
  agent.roomUpdate({ arrived: [{ origin: 'unknown', personKey: null, label: '', prefill: {}, notes: '' }] });
  sent.length = 0;
  return { agent, sent };
}

const formWith = (submit) => ({ ...visit, submit });
const FULL = { visitante: 'Víctor Dávalos', procedencia: 'Dominos', motivo: 'entrega', anfitrion: 'Amalia' };

/** Drive one tool call through the agent without awaiting the whole loop. */
function fire(agent, name, args, n = 1) {
  agent.handleEvent({
    type: 'response.done',
    response: {
      id: `resp_${n}`, status: 'completed',
      output: [{ type: 'function_call', name, call_id: `c${n}`, arguments: JSON.stringify(args) }],
    },
  });
}

const beats = (sent) => sent.filter((e) => e.type === 'response.create' && e.response?.tool_choice === 'none');
const outputs = (sent) => sent.filter((e) => e.item?.type === 'function_call_output')
  .map((e) => JSON.parse(e.item.output));
const systemNotes = (sent) => sent
  .filter((e) => e.item?.role === 'system').map((e) => e.item.content[0].text);

describe('decorating a tool', () => {
  test('an undecorated tool is untouched', async () => {
    const plain = async () => ({ folio: 'V-1' });
    assert.equal(modeOf(plain), null);

    const { agent, sent } = harness(formWith(plain));
    fire(agent, 'save_fields', { registration: 'r1', fields: FULL });
    await tick();
    fire(agent, 'submit_form', { registration: 'r1' }, 2);
    await tick();

    assert.equal(agent.busy, false, 'nothing should hold the floor');
    assert.deepEqual(outputs(sent).at(-1), { ok: true, registration: 'r1', folio: 'V-1' });
    assert.equal(agent.registrations.get('r1').status, 'submitted');
  });

  test('the wrapper carries its settings and still calls through', async () => {
    const meta = modeOf(blocking(async () => 1, { say: 'espera', timeoutMs: 5 }));
    assert.equal(meta.hold, true);
    assert.equal(meta.say, 'espera');
    assert.equal(meta.timeoutMs, 5);
    assert.equal(modeOf(deferred(async () => 1)).announce, true);
    assert.equal(modeOf(background(async () => 1)).announce, false);
  });
});

describe('blocking: she walks away from the desk', () => {
  test('a fast tool is never announced', async () => {
    const { agent, sent } = harness(formWith(blocking(async () => ({ folio: 'V-2' }))));
    fire(agent, 'save_fields', { registration: 'r1', fields: FULL });
    await tick();
    sent.length = 0;
    fire(agent, 'submit_form', { registration: 'r1' }, 2);
    await tick(60);

    assert.equal(beats(sent).length, 0, 'no "un momento" for a tool that returns instantly');
    assert.equal(agent.registrations.get('r1').status, 'submitted');
  });

  test('a slow tool says so, holds the floor, then returns the real result', async () => {
    const net = controllable();
    const { agent, sent } = harness(formWith(
      blocking(net.fn, { say: 'Di que estás guardando.', coverAfterMs: 10 })));

    fire(agent, 'save_fields', { registration: 'r1', fields: FULL });
    await tick();
    sent.length = 0;
    fire(agent, 'submit_form', { registration: 'r1' }, 2);
    await tick(40);

    assert.equal(agent.busy, true, 'the desk is empty while she is away');
    const cover = beats(sent);
    assert.equal(cover.length, 1);
    assert.match(cover[0].response.instructions, /Di que estás guardando/);

    net.resolve({ folio: 'V-3' });
    await tick(40);

    assert.equal(agent.busy, false, 'she is back');
    assert.deepEqual(outputs(sent).at(-1), { ok: true, registration: 'r1', folio: 'V-3' });
  });

  test('the microphone is dead while she is away', async () => {
    const net = controllable();
    const { agent, sent } = harness(formWith(blocking(net.fn, { coverAfterMs: 10 })));
    fire(agent, 'save_fields', { registration: 'r1', fields: FULL });
    await tick();
    fire(agent, 'submit_form', { registration: 'r1' }, 2);
    await tick(40);

    sent.length = 0;
    agent.sendAudio(Buffer.alloc(480));
    assert.equal(sent.length, 0, 'audio must not reach a receptionist who is not there');

    net.resolve({ folio: 'V-4' });
    await tick(40);
    agent.sendAudio(Buffer.alloc(480));
    assert.equal(sent.filter((e) => e.type === 'input_audio_buffer.append').length, 1);
  });

  test('the client is not told it is their turn mid-wait', async () => {
    const net = controllable();
    const { agent } = harness(formWith(blocking(net.fn, { coverAfterMs: 10 })));
    fire(agent, 'save_fields', { registration: 'r1', fields: FULL });
    await tick();
    fire(agent, 'submit_form', { registration: 'r1' }, 2);
    await tick(40);

    let idles = 0;
    agent.on('idle', () => { idles += 1; });
    // The cover sentence finishes while the tool is still running.
    agent.handleEvent({ type: 'response.done', response: { id: 'resp_cover', status: 'completed', output: [] } });
    assert.equal(idles, 0, 'the visitor must not be prompted to speak');

    net.resolve({ folio: 'V-5' });
    await tick(40);
  });

  test('a failure leaves the registration open to try again', async () => {
    const net = controllable();
    const { agent, sent } = harness(formWith(blocking(net.fn, { coverAfterMs: 10 })));
    fire(agent, 'save_fields', { registration: 'r1', fields: FULL });
    await tick();
    fire(agent, 'submit_form', { registration: 'r1' }, 2);
    await tick(40);

    net.reject(new Error('portal down'));
    await tick(40);

    assert.equal(agent.registrations.get('r1').status, 'open', 'never claim a save that failed');
    assert.equal(outputs(sent).at(-1).ok, false);
    assert.equal(agent.busy, false);
  });

  test('a tool that never answers gives up on its own', async () => {
    const never = blocking(() => new Promise(() => {}), { timeoutMs: 40, coverAfterMs: 5 });
    const { agent, sent } = harness(formWith(never));
    fire(agent, 'save_fields', { registration: 'r1', fields: FULL });
    await tick();
    fire(agent, 'submit_form', { registration: 'r1' }, 2);
    await tick(150);

    assert.equal(agent.busy, false, 'a hung endpoint must not hold the mic shut forever');
    assert.equal(outputs(sent).at(-1).ok, false);
    assert.equal(agent.registrations.get('r1').status, 'open');
  });
});

describe('deferred and background: she keeps talking', () => {
  const withTool = (run) => ({
    ...visit,
    tools: [{ definition: { type: 'function', name: 'avisar', parameters: { type: 'object', properties: {} } }, run }],
  });

  test('deferred answers at once, then cuts in with the outcome', async () => {
    const net = controllable();
    const { agent, sent } = harness(withTool(deferred(net.fn, { done: (r) => `Ya llegó: ${r.msg}` })));

    fire(agent, 'avisar', { registration: 'r1' });
    await tick();
    assert.equal(outputs(sent).at(-1).status, 'in_progress');
    assert.equal(agent.busy, false, 'she never left the desk');

    sent.length = 0;
    net.resolve({ msg: 'listo' });
    await tick(40);

    assert.match(systemNotes(sent).join(' '), /Ya llegó: listo/);
    assert.equal(beats(sent).length, 1, 'the interjection must be spoken, not skipped');
  });

  test('deferred apologises when it fails', async () => {
    const net = controllable();
    const { agent, sent } = harness(withTool(deferred(net.fn, { fail: () => 'Discúlpate, falló.' })));
    fire(agent, 'avisar', { registration: 'r1' });
    await tick();
    sent.length = 0;

    net.reject(new Error('nope'));
    await tick(40);
    assert.match(systemNotes(sent).join(' '), /Discúlpate, falló/);
  });

  test('background is never mentioned again', async () => {
    const net = controllable();
    const { agent, sent } = harness(withTool(background(net.fn)));
    fire(agent, 'avisar', { registration: 'r1' });
    await tick();
    assert.equal(outputs(sent).at(-1).status, 'in_progress');

    sent.length = 0;
    net.resolve({ msg: 'listo' });
    await tick(40);
    assert.equal(sent.length, 0, 'fire and forget means forget');
  });
});

describe('withTimeout', () => {
  test('passes a value through and stops the clock', async () => {
    assert.equal(await withTimeout(Promise.resolve(7), 50), 7);
  });

  test('rejects once the deadline passes', async () => {
    await assert.rejects(() => withTimeout(new Promise(() => {}), 20), /timed out after 20ms/);
  });
});
