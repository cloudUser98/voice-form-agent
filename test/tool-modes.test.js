// Tools that reach out to the internet. Offline: the "network" is a promise
// this file resolves by hand, so every timing case is exact.
process.env.TRACE = 'off';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import visit from '../forms/visit.js';
import { FormAgent } from '../src/agent.js';
import { blocking, deferred, background, modeOf, withTimeout } from '../src/tools.js';
import { stubHosts } from './hosts-stub.js';

// visit's `anfitrion` is checked against the staff directory. Offline, that
// directory is this list.
stubHosts();

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

describe('verify: a value the world has to agree with', () => {
  const formWithVerify = (verify) => ({
    ...visit,
    submit: async () => ({ folio: 'V-9' }),
    schema: {
      ...visit.schema,
      properties: {
        ...visit.schema.properties,
        anfitrion: { ...visit.schema.properties.anfitrion, verify },
      },
    },
  });

  const save = (agent, fields, n = 1) => fire(agent, 'save_fields', { registration: 'r1', fields }, n);
  const state = (agent) => agent.registrations.get('r1').state;

  test('a refused value never lands in the form', async () => {
    const { agent, sent } = harness(formWithVerify(async () => ({ ok: false, error: 'no existe' })));
    save(agent, FULL);
    await tick();

    const out = outputs(sent).at(-1);
    assert.deepEqual(out.rejected, ['anfitrion: no existe'], 'the reason travels back as a rejection');
    assert.ok(!out.saved.includes('anfitrion'), 'never report a refused value as saved');
    assert.ok(out.missing.includes('anfitrion'), 'so the board asks for it again');
    assert.equal(state(agent).data.anfitrion, undefined);
    assert.equal(state(agent).evidence.anfitrion, undefined, 'no provenance for a value that is not there');
    assert.equal(state(agent).data.procedencia, 'Dominos', 'the rest of the same patch is untouched');
  });

  test('an approved value stands, and the same answer is only looked up once', async () => {
    let calls = 0;
    const { agent, sent } = harness(formWithVerify(async () => { calls += 1; return { ok: true }; }));
    save(agent, FULL);
    await tick();
    save(agent, { anfitrion: FULL.anfitrion }, 2);        // the model repeats itself
    await tick();

    assert.equal(calls, 1, 'a visitor must not wait twice for the same lookup');
    assert.equal(state(agent).data.anfitrion, 'Amalia');
    assert.deepEqual(outputs(sent).at(-1).missing, []);
  });

  test('a different answer is looked up again', async () => {
    let calls = 0;
    const { agent } = harness(formWithVerify(async () => { calls += 1; return { ok: true }; }));
    save(agent, FULL);
    await tick();
    save(agent, { anfitrion: 'Otra Persona' }, 2);
    await tick();

    assert.equal(calls, 2);
    assert.equal(state(agent).data.anfitrion, 'Otra Persona');
  });

  test('a slow check holds the floor and says who it is looking up', async () => {
    const net = controllable();
    const { agent, sent } = harness(formWithVerify(blocking(net.fn, {
      say: (name) => `Di que estás viendo si ${name} puede recibirlos.`, coverAfterMs: 10,
    })));

    save(agent, FULL);
    await tick(40);

    assert.equal(agent.busy, true, 'the microphone is shut while she checks');
    const cover = beats(sent);
    assert.equal(cover.length, 1);
    assert.match(cover[0].response.instructions, /si Amalia puede recibirlos/);

    net.resolve({ ok: true });
    await tick(40);

    assert.equal(agent.busy, false, 'she is back');
    assert.deepEqual(outputs(sent).at(-1).missing, [], 'and the value stuck');
  });

  test('a check that throws is a refusal, not a crash', async () => {
    const { agent, sent } = harness(formWithVerify(async () => { throw new Error('ECONNREFUSED'); }));
    save(agent, FULL);
    await tick();

    assert.match(outputs(sent).at(-1).rejected.join(' '), /^anfitrion: /);
    assert.equal(state(agent).data.anfitrion, undefined);
  });

  test('a check that never answers gives up and refuses', async () => {
    const { agent, sent } = harness(formWithVerify(
      blocking(() => new Promise(() => {}), { timeoutMs: 30, coverAfterMs: 5 })));
    save(agent, FULL);
    await tick(120);

    assert.equal(agent.busy, false, 'a hung directory must not hold the mic shut forever');
    assert.ok(outputs(sent).at(-1).missing.includes('anfitrion'));
    assert.equal(agent.registrations.get('r1').status, 'open', 'the visitor can still try again');
  });

  // The others fake the check. This one is the real form, the real forms/api.js
  // and the real HTTP parsing — only the directory itself is stubbed.
  test('the visit form really does check its host against the directory', async () => {
    const { agent, sent } = harness(visit);
    save(agent, { ...FULL, anfitrion: 'Rodrigo Salinas' });
    await tick();

    const out = outputs(sent).at(-1);
    assert.ok(out.missing.includes('anfitrion'), 'a stranger does not get to be the host');
    assert.match(out.rejected.join(' '), /directorio/);

    save(agent, { anfitrion: 'Amalia' }, 2);              // half a name the directory does hold
    await tick();
    assert.deepEqual(outputs(sent).at(-1).missing, []);
    assert.equal(state(agent).data.anfitrion, 'Amalia');
  });

  test('what comes from outside the conversation is not second-guessed', async () => {
    let calls = 0;
    const { agent } = harness(formWithVerify(async () => { calls += 1; return { ok: false, error: 'no existe' }; }));

    // A human read the screen and overruled the agent.
    assert.deepEqual(agent.correct('anfitrion', 'Quien Sea', 'r1'), { ok: true });
    // And the camera claims to know who the next person is here to see.
    agent.roomUpdate({ arrived: [{ origin: 'known', personKey: 'p2', label: 'Ana', prefill: { anfitrion: 'Fantasma' }, notes: '' }] });
    await tick();

    assert.equal(calls, 0, 'the directory only judges what was spoken into save_fields');
    assert.equal(state(agent).data.anfitrion, 'Quien Sea');
    assert.equal(agent.registrations.get('r2').state.data.anfitrion, 'Fantasma');
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
