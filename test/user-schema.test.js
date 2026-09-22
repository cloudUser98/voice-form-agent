// Known users: a form started for somebody the integrator already knows, with
// the values from their profile prefilled and some of them protected. Offline
// except the one `live` block at the end — the engine's promises are proven
// here, whether the model behaves is proven there.
process.env.TRACE = 'off';

import 'dotenv/config';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import visit from '../forms/visit.js';
import visitor from '../users/visitor.js';
import { FormAgent } from '../src/agent.js';
import { buildTools } from '../src/prompt.js';
import { userSchemaProblems, fromUser, sameValue, explanation } from '../src/user.js';
import { toPerson, planFromSnapshot } from '../src/detector.js';
import { converse, withoutClient } from './helpers.js';

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// Its own small form, because every field on it is the subject of some test
// below: one of each kind of protection, one editable, one private, one that
// the world has to agree with.
const USER = {
  key: 'id',
  properties: {
    id: { type: 'string' },
    nombre: { type: 'string', prefill: true, confirmOnly: true, beforeUpdate: 'RENAMES-THEIR-PROFILE' },
    email: { type: 'string', prefill: true, confirmOnly: true },
    documento: { type: 'string', prefill: true, readOnly: true, beforeUpdate: 'ONLY-THE-FRONT-DESK' },
    empresa: { type: 'string', prefill: true },
    secreto: { type: 'string' },
    // The form has a `motivo` too, but the profile's is last visit's reason:
    // known to the user schema, deliberately not prefilled.
    motivo: { type: 'string' },
  },
};

function makeForm(over = {}) {
  const submitted = [];
  const form = {
    name: 'profile-test',
    persona: 'You are a receptionist.',
    onComplete: false,
    labelFrom: 'nombre',
    schema: {
      type: 'object',
      required: ['nombre', 'motivo'],
      properties: {
        nombre: { type: 'string', minLength: 2, maxLength: 40 },
        email: {
          type: 'string',
          // The world refuses one domain, so a confirmed change can be refused.
          verify: async (v) => (v.endsWith('@blocked.com') ? { ok: false, error: 'BLOCKED-DOMAIN' } : { ok: true }),
        },
        documento: { type: 'string' },
        empresa: { type: 'string' },
        motivo: { type: 'string' },
      },
    },
    user: USER,
    tools: [{
      definition: { type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } },
      run: async () => ({ ok: true, fields: { nombre: 'Nombre De Una Cita' } }),
    }],
    async submit(data, ctx) { submitted.push({ data, ctx }); return { folio: 'F-1' }; },
    ...over,
  };
  return { form, submitted };
}

// Distinctive values, so "never reaches the model" can be checked by searching
// everything that was sent for them.
const LUIS = {
  id: 'KEY-7f3a91',
  nombre: 'Luis',
  email: 'luis@mail.com',
  documento: 'INE-123',
  empresa: 'Bimbo',
  secreto: 'SECRET-vip-9',
  color_favorito: 'EXTRA-azul',
  motivo: 'STALE-last-visit',
};

function harness({ record = LUIS, form } = {}) {
  const made = form ? { form, submitted: [] } : makeForm();
  const agent = new FormAgent({ form: made.form, mode: 'text', apiKey: 'test-key' });
  const sent = [];
  const done = [];
  agent.realTimeWs = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };
  agent.on('done', (d) => done.push(d));
  agent.handleEvent({ type: 'session.updated' });
  const arrived = agent.arrive(record);

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
    await tick();
    const out = sent.find((e) => e.item?.type === 'function_call_output');
    return out ? JSON.parse(out.item.output) : null;
  };

  const reg = () => agent.registrations.get('r1');
  // The response the engine asked for after the tool round, if it asked for one.
  const nextResponse = () => sent.filter((e) => e.type === 'response.create').at(-1);
  // The instructions the model is working from right now.
  const board = () => sent.filter((e) => e.type === 'session.update').at(-1)?.session.instructions || '';

  return { agent, call, sent, done, reg, arrived, nextResponse, board, submitted: made.submitted, form: made.form };
}

// ---------------------------------------------------------------------------

describe('loading a user schema', () => {
  test('a well-formed one has nothing to say', () => {
    assert.deepEqual(userSchemaProblems(makeForm().form), []);
  });

  test('a form without one is untouched', () => {
    assert.deepEqual(userSchemaProblems(visit), []);
  });

  test('the example visitor schema fits the real visit form', () => {
    assert.deepEqual(userSchemaProblems({ ...visit, user: visitor }), []);
  });

  test('a user field whose type differs from the form field fails at load', () => {
    const { form } = makeForm({ user: { ...USER, properties: { ...USER.properties, empresa: { type: 'integer', prefill: true } } } });
    assert.match(userSchemaProblems(form).join(), /empresa: is integer but the form's empresa is string/);
    assert.throws(() => new FormAgent({ form, mode: 'text', apiKey: 'test-key' }), /empresa/);
  });

  test('the key can never be prefilled', () => {
    const { form } = makeForm({ user: { ...USER, properties: { ...USER.properties, id: { type: 'string', prefill: true } } } });
    assert.match(userSchemaProblems(form).join(), /key can never be prefilled/);
  });

  test('a key has to be named', () => {
    const { form } = makeForm({ user: { properties: USER.properties } });
    assert.match(userSchemaProblems(form).join(), /user\.key/);
  });

  test('a field the client captures cannot be prefilled', () => {
    const form = { ...visit, user: { key: 'id', properties: { foto: { type: 'string', prefill: true } } } };
    assert.match(userSchemaProblems(form).join(), /foto: .*captured by the client/);
  });

  test('flags must be booleans and beforeUpdate text', () => {
    const { form } = makeForm({
      user: { key: 'id', properties: { nombre: { type: 'string', prefill: 'yes', beforeUpdate: 42 } } },
    });
    const problems = userSchemaProblems(form).join();
    assert.match(problems, /nombre\.prefill/);
    assert.match(problems, /nombre\.beforeUpdate/);
  });

  test('a field this form does not have is simply not its business', () => {
    const { form } = makeForm({
      user: { ...USER, properties: { ...USER.properties, telefono: { type: 'integer', prefill: true } } },
    });
    assert.deepEqual(userSchemaProblems(form), []);
  });
});

describe('arriving', () => {
  test('only prefill fields the form has are prefilled, and they say so', () => {
    const { reg } = harness();
    assert.deepEqual(reg().state.data, { nombre: 'Luis', email: 'luis@mail.com', documento: 'INE-123', empresa: 'Bimbo' });
    assert.equal(reg().state.evidence.nombre.source, 'prefill');
    assert.equal(reg().personKey, 'KEY-7f3a91');
  });

  test('a field both schemas have is not prefilled unless the user schema says so', () => {
    const { reg } = harness();
    assert.equal(reg().state.data.motivo, undefined);
    assert.deepEqual(reg().state.missing(), ['motivo']);
  });

  test('the key, private fields and unknown fields never reach the model', async () => {
    const { agent, call, sent } = harness();
    const everything = [];
    const keep = () => everything.push(...sent.map((e) => JSON.stringify(e)));
    keep();
    // Arriving, a tool round and a proposal: every road that writes to OpenAI.
    await call('save_fields', { registration: 'r1', fields: { motivo: 'junta', nombre: 'Luis Miguel' } });
    keep();
    agent.handleEvent({ type: 'response.done', response: { output: [] } });
    const all = [...everything, JSON.stringify(agent.sessionConfig())].join('\n');
    for (const secret of ['KEY-7f3a91', 'SECRET-vip-9', 'EXTRA-azul', 'STALE-last-visit']) {
      assert.ok(!all.includes(secret), `${secret} was sent to OpenAI`);
    }
  });

  test('nobody known is a new user, with nothing prefilled', () => {
    const { agent, reg } = harness({ record: null });
    assert.equal(reg().origin, 'unknown');
    assert.deepEqual(reg().state.data, {});
    assert.equal(agent.registrations.size, 1);
  });

  for (const [why, record, expected] of [
    ['a wrong type', { ...LUIS, nombre: 42 }, /nombre: expected text/],
    ['a missing key', { ...LUIS, id: '' }, /id: missing/],
    ['a value the form would refuse', { ...LUIS, nombre: 'L'.repeat(41) }, /nombre: too long/],
    ['something that is not a record', 'Luis', /expected a record/],
  ]) {
    test(`a record with ${why} is refused and nobody is registered`, () => {
      const { agent, arrived } = harness({ record });
      assert.equal(arrived.ok, false);
      assert.match(arrived.problems.join(), expected);
      assert.equal(agent.registrations.size, 0);
    });
  }

  test('a field the user schema requires has to be there', () => {
    const { form } = makeForm({ user: { ...USER, required: ['email'] } });
    const { arrived } = harness({ form, record: { ...LUIS, email: undefined } });
    assert.equal(arrived.ok, false);
    assert.match(arrived.problems.join(), /email: required/);
  });

  test('the same person twice is refused the second time', () => {
    const { agent } = harness();
    const again = agent.arrive(LUIS);
    assert.equal(again.ok, false);
    assert.match(again.problems.join(), /already has an open registration/);
    assert.equal(agent.registrations.size, 1);
  });

  test('a form with no user schema refuses a record rather than guessing', () => {
    const agent = new FormAgent({ form: withoutClient(visit), mode: 'text', apiKey: 'test-key' });
    const r = agent.arrive({ persona_id: 'p1', visitante: 'Luis' });
    assert.equal(r.ok, false);
    assert.equal(agent.registrations.size, 0);
  });
});

describe('the camera as a connector', () => {
  const form = { ...visit, user: visitor };
  const seen = {
    persona_id: 'p_luis', track_id: 7, visitante: 'Luis Escobedo', procedencia: 'Bimbo',
    anfitrion: 'Amalia Gastelum', nivel_acceso: 'PRIVATE-admin',
  };

  test('reads a detection as the user record', () => {
    const p = toPerson(seen, form);
    assert.equal(p.personKey, 'p_luis');
    // anfitrion is a visit field but the user schema does not prefill it.
    assert.deepEqual(p.prefill, { visitante: 'Luis Escobedo', procedencia: 'Bimbo' });
    assert.ok(p.protect.visitante.confirmOnly);
  });

  test('context stays context and private stays private', () => {
    const p = toPerson(seen, form);
    assert.match(p.notes, /track_id: 7/);
    assert.doesNotMatch(p.notes, /PRIVATE-admin|p_luis/);
  });

  test('a record that does not fit is marked refused, and carries why', () => {
    const p = toPerson({ ...seen, visitante: 'L' }, form);
    assert.ok(p.refused);
    assert.match(p.refused.join(), /visitante: too short/);
    assert.deepEqual(p.prefill, {});
  });

  test('a form without a user schema reads the camera exactly as before', () => {
    const p = toPerson(seen, visit);
    assert.equal(p.prefill.anfitrion, 'Amalia Gastelum');
    assert.equal(p.protect, undefined);
  });

  test('refused people still show up in the plan, for the server to report', () => {
    const plan = planFromSnapshot(
      { type: 'people_detected', conocidos: [{ ...seen, visitante: 'L' }], desconocidos: [] }, form, new Map());
    assert.equal(plan.arrived.length, 1);
    assert.ok(plan.arrived[0].refused);
  });
});

describe('the gate', () => {
  test('a new user fills a protected field like any other', async () => {
    const { call, reg } = harness({ record: null });
    const r = await call('save_fields', { registration: 'r1', fields: { nombre: 'Luis Miguel' } });
    assert.deepEqual(r.saved, ['nombre']);
    assert.equal(r.pending_confirmation, undefined);
    assert.equal(reg().state.data.nombre, 'Luis Miguel');
  });

  test('a changed confirmOnly value is proposed, not written', async () => {
    const { call, reg } = harness();
    const r = await call('save_fields', { registration: 'r1', fields: { nombre: 'Luis Miguel' }, quotes: { nombre: 'soy Luis Miguel' } });
    assert.deepEqual(r.saved, []);
    assert.deepEqual(r.pending_confirmation, ['nombre']);
    assert.equal(reg().state.data.nombre, 'Luis');
    assert.equal(reg().state.evidence.nombre.source, 'prefill');
    assert.deepEqual(reg().proposals.get('nombre'), { from: 'Luis', to: 'Luis Miguel', quote: 'soy Luis Miguel', asked: true });
  });

  test('the same value in other capitals or spacing is not a change', async () => {
    const { call, reg } = harness();
    const r = await call('save_fields', { registration: 'r1', fields: { nombre: '  luis ' } });
    assert.equal(r.pending_confirmation, undefined);
    assert.equal(reg().proposals.size, 0);
    assert.equal(reg().state.data.nombre, 'Luis');
    assert.equal(reg().state.evidence.nombre.source, 'prefill', 'repeating it does not make it heard');
  });

  test('a value the form would refuse is refused, never proposed', async () => {
    const { call, reg } = harness();
    const r = await call('save_fields', { registration: 'r1', fields: { nombre: 'X'.repeat(41) } });
    assert.match(r.rejected.join(), /nombre: too long/);
    assert.equal(reg().proposals.size, 0);
  });

  test('readOnly is refused with the integrator\'s reason', async () => {
    const { call, reg } = harness();
    const r = await call('save_fields', { registration: 'r1', fields: { documento: 'PASAPORTE-9' } });
    assert.match(r.rejected.join(), /documento: ONLY-THE-FRONT-DESK/);
    assert.equal(reg().state.data.documento, 'INE-123');
    assert.equal(reg().proposals.size, 0);
  });

  test('without a reason, a sensible default is given', () => {
    assert.match(explanation({ readOnly: true, beforeUpdate: '' }), /cannot be changed here/);
    assert.match(explanation({ confirmOnly: true, beforeUpdate: '' }), /change it in their profile/);
  });

  test('readOnly wins over confirmOnly', async () => {
    const { form } = makeForm({
      user: { ...USER, properties: { ...USER.properties, documento: { type: 'string', prefill: true, readOnly: true, confirmOnly: true } } },
    });
    const { call, reg } = harness({ form });
    const r = await call('save_fields', { registration: 'r1', fields: { documento: 'OTRO' } });
    assert.ok(r.rejected);
    assert.equal(reg().proposals.size, 0);
  });

  test('a prefilled field with no protection changes freely', async () => {
    const { call, reg } = harness();
    const r = await call('save_fields', { registration: 'r1', fields: { empresa: 'Lala' } });
    assert.deepEqual(r.saved, ['empresa']);
    assert.equal(reg().state.data.empresa, 'Lala');
  });

  test('protected and ordinary fields in one save: the ordinary ones are saved', async () => {
    const { call, reg } = harness();
    const r = await call('save_fields', { registration: 'r1', fields: { motivo: 'junta', nombre: 'Luis Miguel' } });
    assert.deepEqual(r.saved, ['motivo']);
    assert.deepEqual(r.pending_confirmation, ['nombre']);
    assert.equal(reg().state.data.motivo, 'junta');
  });

  test('a tool that brings back fields goes through the gate too', async () => {
    const { call, reg } = harness();
    const r = await call('lookup', { registration: 'r1' });
    assert.deepEqual(r.pending_confirmation, ['nombre']);
    assert.equal(reg().state.data.nombre, 'Luis');
  });

  test('staff can change readOnly and confirmOnly values, and that settles a pending change', async () => {
    const { agent, call, reg } = harness();
    await call('save_fields', { registration: 'r1', fields: { nombre: 'Luis Miguel' } });
    assert.equal(agent.correct('documento', 'PASAPORTE-9', 'r1').ok, true);
    assert.equal(agent.correct('nombre', 'Luis M.', 'r1').ok, true);
    assert.equal(reg().state.data.documento, 'PASAPORTE-9');
    assert.equal(reg().state.data.nombre, 'Luis M.');
    assert.equal(reg().proposals.size, 0);
  });
});

describe('asking before changing', () => {
  test('a proposal gets a forced turn that carries the reason and both values', async () => {
    const { call, nextResponse } = harness();
    await call('save_fields', { registration: 'r1', fields: { nombre: 'Luis Miguel' } });
    const beat = nextResponse()?.response;
    assert.ok(beat, 'a response should have been asked for');
    assert.equal(beat.tool_choice, 'none', 'it must be speech — no tool can skip it');
    assert.match(beat.instructions, /RENAMES-THEIR-PROFILE/);
    assert.match(beat.instructions, /"Luis" to "Luis Miguel"/);
    assert.match(beat.instructions, /You are a receptionist/, 'the persona rides along');
  });

  test('it is asked once, not on every turn after', async () => {
    const { call, nextResponse } = harness();
    await call('save_fields', { registration: 'r1', fields: { nombre: 'Luis Miguel' } });
    await call('save_fields', { registration: 'r1', fields: { motivo: 'junta' } });
    assert.equal(nextResponse()?.response?.tool_choice, undefined);
  });

  test('while it waits, the board says so', async () => {
    const { call, board } = harness();
    await call('save_fields', { registration: 'r1', fields: { nombre: 'Luis Miguel' } });
    assert.match(board(), /awaiting their confirmation to change: nombre "Luis" → "Luis Miguel"/);
  });

  test('confirm_change is only offered when something can need confirming', () => {
    assert.ok(buildTools(makeForm().form).some((t) => t.name === 'confirm_change'));
    assert.ok(!buildTools(visit).some((t) => t.name === 'confirm_change'));
  });
});

describe('the answer', () => {
  test('yes writes it, and the screen learns what it replaced', async () => {
    const { call, reg } = harness();
    await call('save_fields', { registration: 'r1', fields: { nombre: 'Luis Miguel' }, quotes: { nombre: 'soy Luis Miguel' } });
    const r = await call('confirm_change', { registration: 'r1', field: 'nombre', accept: true, quote: 'sí, cámbialo' });
    assert.deepEqual(r.saved, ['nombre']);
    assert.equal(reg().state.data.nombre, 'Luis Miguel');
    assert.deepEqual(reg().state.evidence.nombre, {
      source: 'heard', heard: 'soy Luis Miguel', previous: 'Luis', confirmed: true, confirmedWith: 'sí, cámbialo',
    });
    assert.equal(reg().proposals.size, 0);
  });

  test('no keeps the profile\'s value, untouched', async () => {
    const { call, reg } = harness();
    await call('save_fields', { registration: 'r1', fields: { nombre: 'Luis Miguel' } });
    const r = await call('confirm_change', { registration: 'r1', field: 'nombre', accept: false });
    assert.deepEqual(r.saved, []);
    assert.equal(reg().state.data.nombre, 'Luis');
    assert.equal(reg().state.evidence.nombre.source, 'prefill');
  });

  test('once answered, the old value is gone from everything the model reads', async () => {
    const { call, board } = harness();
    await call('save_fields', { registration: 'r1', fields: { nombre: 'Luis Miguel' } });
    const r = await call('confirm_change', { registration: 'r1', field: 'nombre', accept: true });
    const b = board();
    assert.match(b, /nombre="Luis Miguel"/);
    assert.doesNotMatch(b, /"Luis"/, 'the old value lingers on the board');
    assert.doesNotMatch(b, /previous|confirmed/);
    assert.doesNotMatch(JSON.stringify(r), /"Luis"|previous/, 'nor in what the tool told the model');
  });

  test('an answer to a question nobody asked is refused', async () => {
    const { call } = harness();
    const r = await call('confirm_change', { registration: 'r1', field: 'nombre', accept: true });
    assert.equal(r.ok, false);
  });

  test('a confirmed value the world refuses does not cost them the old one', async () => {
    const { call, reg } = harness();
    await call('save_fields', { registration: 'r1', fields: { email: 'luis@blocked.com' } });
    const r = await call('confirm_change', { registration: 'r1', field: 'email', accept: true });
    assert.match(r.rejected.join(), /BLOCKED-DOMAIN/);
    assert.equal(reg().state.data.email, 'luis@mail.com');
    assert.equal(reg().state.evidence.email.source, 'prefill');
  });

  test('a second change is measured from the profile, and asked again', async () => {
    const { call, reg } = harness();
    await call('save_fields', { registration: 'r1', fields: { nombre: 'Luis Miguel' } });
    await call('confirm_change', { registration: 'r1', field: 'nombre', accept: true });
    const r = await call('save_fields', { registration: 'r1', fields: { nombre: 'Luis Miguel Pérez' } });
    assert.deepEqual(r.pending_confirmation, ['nombre']);
    assert.equal(reg().proposals.get('nombre').from, 'Luis Miguel');
  });

  test('going back to the profile\'s own value needs no confirmation', async () => {
    const { call, reg } = harness();
    await call('save_fields', { registration: 'r1', fields: { nombre: 'Luis Miguel' } });
    await call('confirm_change', { registration: 'r1', field: 'nombre', accept: true });
    const r = await call('save_fields', { registration: 'r1', fields: { nombre: 'Luis' } });
    assert.deepEqual(r.saved, ['nombre']);
    assert.equal(reg().state.data.nombre, 'Luis');
  });
});

describe('submitting', () => {
  test('refused while a change is waiting for an answer', async () => {
    const { call, submitted } = harness();
    await call('save_fields', { registration: 'r1', fields: { motivo: 'junta', nombre: 'Luis Miguel' } });
    const r = await call('submit_form', { registration: 'r1' });
    assert.equal(r.ok, false);
    assert.deepEqual(r.pending_confirmation, ['nombre']);
    assert.equal(submitted.length, 0);
  });

  test('the key travels beside the data, to submit and to done — never inside it', async () => {
    const { call, submitted, done } = harness();
    await call('save_fields', { registration: 'r1', fields: { motivo: 'junta' } });
    const r = await call('submit_form', { registration: 'r1' });
    assert.equal(r.ok, true);
    assert.deepEqual(submitted[0].ctx, { key: 'KEY-7f3a91' });
    assert.equal(done[0].key, 'KEY-7f3a91');
    assert.ok(!JSON.stringify(submitted[0].data).includes('KEY-7f3a91'));
    assert.ok(!JSON.stringify(r).includes('KEY-7f3a91'), 'nor in what the model is told');
  });

  test('a new user submits with a null key', async () => {
    const { call, submitted } = harness({ record: null });
    await call('save_fields', { registration: 'r1', fields: { nombre: 'Ana Ruiz', motivo: 'junta' } });
    await call('submit_form', { registration: 'r1' });
    assert.deepEqual(submitted[0].ctx, { key: null });
  });

  test('read-back waits for the answer, then happens', async () => {
    const { form } = makeForm({ onComplete: 'read-back' });
    const { call, nextResponse } = harness({ form });
    // This save completes the form AND proposes a change, in one turn.
    await call('save_fields', { registration: 'r1', fields: { motivo: 'junta', nombre: 'Luis Miguel' } });
    assert.match(nextResponse().response.instructions, /RENAMES-THEIR-PROFILE/, 'the change is asked about first');
    assert.doesNotMatch(nextResponse().response.instructions, /NOT yet submitted/);

    await call('confirm_change', { registration: 'r1', field: 'nombre', accept: true });
    assert.match(nextResponse()?.response?.instructions || '', /NOT yet submitted/, 'then it is read back');
    assert.match(nextResponse().response.instructions, /Luis Miguel/);
  });
});

describe('sameValue', () => {
  test('ignores case, spacing and composed accents', () => {
    assert.ok(sameValue('José  Pérez', ' josé pérez'));
    assert.ok(sameValue('José', 'José'));
    assert.ok(!sameValue('Luis', 'Luis Miguel'));
    assert.ok(sameValue(3, 3));
    assert.ok(!sameValue(3, '3'));
  });
});

// ---------------------------------------------------------------------------
// Live: the only part that shows the model actually says the warning and acts
// on the answer. The engine guarantees nothing is written without a yes; this
// shows the yes and the no both land where they should.

const live = { skip: process.env.OPENAI_API_KEY ? false : 'no OPENAI_API_KEY', timeout: 150000 };

// The real visit, with the example visitor schema, no camera, and a submit that
// goes nowhere — a live test must not register visits in their system.
const knownVisit = {
  ...withoutClient(visit),
  user: visitor,
  submit: async () => ({ folio: 'TEST' }),
};
const luis = { persona_id: 'p_luis', visitante: 'Luis', procedencia: 'Bimbo' };

describe('live: a known visitor changes their name', () => {
  for (const [answer, accept, expected] of [
    ['Sí, cámbialo por favor.', true, 'Luis Miguel'],
    ['No, mejor déjalo como está.', false, 'Luis'],
  ]) {
    test(`they say ${accept ? 'yes' : 'no'}`, live, async () => {
      const r = await converse(knownVisit, [
        'Hola. Oye, mi nombre completo es Luis Miguel, regístrame así.',
        answer,
        'Vengo a una junta de seguimiento con Amalia Gastelum.',
        'Sí, todo correcto.',
        'Sí.',
      ], { user: luis });

      const warned = r.transcript.some((m) => m.role === 'agent' && /perfil/i.test(m.text));
      assert.ok(warned, 'the agent should have explained that the profile changes');
      assert.equal(r.data.visitante, expected);
      if (accept) {
        assert.equal(r.evidence.visitante?.confirmed, true);
        assert.equal(r.evidence.visitante?.previous, 'Luis');
      } else {
        assert.equal(r.evidence.visitante?.source, 'prefill');
      }
    });
  }
});
