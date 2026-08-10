// A field only the client can fill.
//
// The failure this covers is not a broken photo — it is sixty kilobytes of
// base64 reaching the model. `data` is read by the board, which restates every
// value into the session instructions on each change; by the trace; by the
// debug stream; and by the tool result itself. What lands there is a token, and
// these tests are mostly about proving the bytes are nowhere near it.
process.env.TRACE = 'off';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import visit from '../forms/visit.js';
import { FormAgent } from '../src/agent.js';
import { buildTools } from '../src/prompt.js';
import { converse, fill } from './helpers.js';
import { stubHosts } from './hosts-stub.js';

stubHosts();

const live = { skip: process.env.OPENAI_API_KEY ? false : 'no OPENAI_API_KEY', timeout: 120000 };
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// Stands in for a real JPEG: long enough that anything leaking it is obvious.
const IMAGE = `data:image/jpeg;base64,${'/9j/4AAQSkZJRg'.repeat(400)}`;
const SPOKEN = fill(visit, { anfitrion: 'Amalia', procedencia: 'Dominos' });

/**
 * An agent with a fake socket and a client that answers when asked. `camera`
 * plays the part of whatever is holding the lens.
 */
function harness({ camera = () => IMAGE, form = visit } = {}) {
  const agent = new FormAgent({ form, mode: 'text', apiKey: 'test-key' });
  const sent = [];
  const debug = [];
  const asked = [];

  agent.ws = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };
  agent.on('debug', (e) => debug.push(e));
  if (camera) {
    agent.on('request', (r) => {
      asked.push(r);
      const answer = camera(r);
      if (answer !== undefined) agent.answer(r.id, answer);
    });
  }
  agent.handleEvent({ type: 'session.updated' });
  agent.roomUpdate({ arrived: [{ origin: 'unknown', personKey: null, label: '', prefill: {}, notes: '' }] });

  let n = 0;
  const call = async (name, args = {}, wait = 20) => {
    agent.handleEvent({
      type: 'response.done',
      response: {
        id: `resp_${++n}`, status: 'completed',
        output: [{ type: 'function_call', name, call_id: `c${n}`, arguments: JSON.stringify(args) }],
      },
    });
    await tick(wait);
    const out = sent.filter((e) => e.item?.type === 'function_call_output').at(-1);
    return out ? JSON.parse(out.item.output) : null;
  };

  const reg = () => agent.registrations.get('r1');
  return { agent, call, sent, debug, asked, reg };
}

describe('asking the client for something', () => {
  test('the tool asks, the client answers, the field fills', async () => {
    const { call, asked, reg } = harness();
    assert.deepEqual(reg().state.missing(), ['visitante', 'procedencia', 'motivo', 'anfitrion', 'foto']);

    const out = await call('take_photo', { registration: 'r1' });

    assert.equal(asked.length, 1);
    assert.equal(asked[0].kind, 'photo', 'the client is told what is wanted');
    assert.equal(asked[0].registration, 'r1', 'and who it is for');
    assert.deepEqual(out, { ok: true }, 'the result says it worked and nothing more');
    assert.ok(!reg().state.missing().includes('foto'), 'the board stops asking for it');
  });

  test('nobody listening answers for itself, so text mode never hangs', async () => {
    // There is no deadline on a request. Without this the offline suite, the
    // CLI and every scripted conversation would wait for a client forever.
    const { call, reg } = harness({ camera: null });
    const out = await call('take_photo', { registration: 'r1' });

    assert.deepEqual(out, { ok: true });
    assert.equal(reg().state.data.foto, 'captured');
    assert.equal(reg().attachments.get('foto'), null, 'and it is honest that there is no photo');
  });

  test('an answer nobody is waiting for is ignored', () => {
    const { agent } = harness({ camera: null });
    assert.equal(agent.answer('q99', IMAGE), false);
  });

  test('the microphone is shut while the photo is being taken', async () => {
    // A camera that takes its time: the answer arrives when this test says so.
    let shutter;
    const { agent, call, sent, reg } = harness({
      camera: (r) => { shutter = () => agent.answer(r.id, IMAGE); },
    });

    call('take_photo', { registration: 'r1' }, 0);
    await tick(40);
    assert.equal(agent.busy, true, 'a tool waiting on a person holds the floor');

    sent.length = 0;
    agent.sendAudio(Buffer.alloc(480));
    assert.equal(sent.length, 0, 'nothing is listened to meanwhile');

    shutter();
    await tick(40);
    assert.equal(agent.busy, false, 'and the floor comes back');
    agent.sendAudio(Buffer.alloc(480));
    assert.ok(sent.some((e) => e.type === 'input_audio_buffer.append'), 'the microphone reopens');
    assert.equal(reg().attachments.get('foto'), IMAGE);
  });

  test('it says what it is doing rather than going quiet', async () => {
    const { call, sent } = harness({ camera: () => undefined });    // never answers
    call('take_photo', { registration: 'r1' }, 0);
    await tick(500);                                  // past the form's coverAfterMs

    const beat = sent.filter((e) => e.type === 'response.create' && e.response?.tool_choice === 'none');
    assert.equal(beat.length, 1, 'a wait with no deadline has to be covered');
    assert.match(beat[0].response.instructions, /miren a la c[áa]mara/);
  });

  test('an unanswered request waits, with no deadline', async () => {
    const { agent, call, reg } = harness({ camera: () => undefined });
    call('take_photo', { registration: 'r1' }, 0);
    await tick(600);

    assert.equal(agent.busy, true, 'somebody is still walking up to the camera');
    assert.equal(agent.pending.size, 1, 'and the agent is still waiting for them');
    assert.ok(reg().state.missing().includes('foto'));
  });
});

describe('the bytes stay out of the model', () => {
  test('what lands in the form is a token, not the photograph', async () => {
    const { call, reg } = harness();
    await call('take_photo', { registration: 'r1' });

    assert.equal(reg().state.data.foto, 'captured');
    assert.equal(reg().attachments.get('foto'), IMAGE, 'the real thing is held beside it');
    assert.equal(reg().state.evidence.foto.source, 'client');
    assert.equal(reg().state.evidence.foto.heard, null, 'nobody said a photograph out loud');
  });

  test('nothing sent to the model or written down contains it', async () => {
    const { call, sent, debug } = harness();
    await call('take_photo', { registration: 'r1' });

    // session.update carries the board, which restates every value in `data`.
    assert.ok(!JSON.stringify(sent).includes(IMAGE), 'the photo must never reach the realtime socket');
    const board = sent.filter((e) => e.type === 'session.update').at(-1).session.instructions;
    assert.match(board, /foto="captured"/, 'the board shows the token instead');

    // The trace and the inspector see the same events.
    assert.ok(!JSON.stringify(debug).includes(IMAGE), 'nor the trace and debug stream');
    const record = debug.find((e) => e.dir === 'tool' && e.name === 'take_photo');
    assert.deepEqual(record.result, { ok: true }, 'the tool result is stripped before it is recorded');
  });

  test('submit is the one place it is put back', async () => {
    let submitted = null;
    const form = { ...visit, submit: async (data) => { submitted = data; return { folio: 'V-1' }; } };
    const { call, reg } = harness({ form });

    await call('save_fields', { registration: 'r1', fields: SPOKEN });
    await call('take_photo', { registration: 'r1' });
    await call('submit_form', { registration: 'r1' });

    assert.equal(submitted.foto, IMAGE, 'the endpoint gets the real photograph');
    assert.equal(submitted.visitante, SPOKEN.visitante, 'along with everything spoken');
    assert.equal(reg().state.snapshot().data.foto, 'captured', 'the screen still shows the token');
  });

  test('a form cannot be submitted on a token alone', async () => {
    const { call } = harness();
    await call('save_fields', { registration: 'r1', fields: SPOKEN });
    const out = await call('submit_form', { registration: 'r1' });

    assert.equal(out.ok, false);
    assert.deepEqual(out.missing, ['foto'], 'a photo is the only way past it');
  });
});

describe('the model cannot fill it itself', () => {
  test('the field is kept out of the tool it would use', () => {
    const [, save] = buildTools(visit);
    const writable = Object.keys(save.parameters.properties.fields.properties);

    assert.equal(save.name, 'save_fields');
    assert.ok(writable.includes('visitante'));
    assert.ok(!writable.includes('foto'), 'it is not offered as something to write');
  });

  test('our own schema keywords never reach the API', () => {
    const [, save] = buildTools(visit);
    const wire = JSON.stringify(save.parameters.properties.fields.properties);
    assert.ok(!wire.includes('client'));
    assert.ok(!wire.includes('verify'));
  });

  test('a value invented for it anyway is refused', async () => {
    // Left in, this satisfies `missing` and take_photo is never called at all.
    const { call, reg } = harness();
    const out = await call('save_fields', {
      registration: 'r1',
      fields: { ...SPOKEN, foto: 'una foto del señor' },
    });

    assert.ok(!out.saved.includes('foto'));
    assert.match(out.rejected.join(' '), /^foto: not yours to fill/);
    assert.ok(out.missing.includes('foto'), 'so the board still asks for it');
    assert.equal(reg().state.data.foto, undefined);
    assert.equal(reg().state.data.visitante, SPOKEN.visitante, 'the rest of the patch is untouched');
  });

  test('the board still says it is needed', async () => {
    const { call, sent } = harness();
    await call('save_fields', { registration: 'r1', fields: SPOKEN });

    const board = sent.filter((e) => e.type === 'session.update').at(-1).session.instructions;
    assert.match(board, /missing: foto/, 'the nag is what gets the tool called');
  });
});

describe('live', () => {
  test('the agent reaches for the camera on its own', live, async () => {
    const asked = [];
    const r = await converse(visit, [
      'Soy Ana Ruiz, vengo de Bimbo a dejar unos papeles con Amalia Gastelum.',
      'Sí, así es.',
    ], {
      onRequest: (req) => { asked.push(req); return IMAGE; },
    });

    assert.equal(asked.length, 1, `the photo was never asked for: ${JSON.stringify(r.missing)}`);
    assert.equal(asked[0].kind, 'photo');
    assert.equal(r.data.foto, 'captured', 'and the token is what the screen was told about');
    assert.equal(r.evidence.foto.source, 'client');
  });
});
