// Who is filling the form, when the integrator already knows them.
//
// A form may carry `user`: a schema describing the integrator's own user
// record. It is shared — one user schema serves every form that kind of user
// fills — so a field this form does not have is simply not this form's
// business. A field fills the form field with the same name, and only when it
// says `prefill: true`.
//
//   export default {
//     key: 'persona_id',                  // identifies the record; never reaches the model
//     properties: {
//       visitante: { type: 'string', prefill: true, confirmOnly: true,
//                    beforeUpdate: 'Si cambias el nombre aquí, cambia también en tu perfil.' },
//       documento: { type: 'string', prefill: true, readOnly: true,
//                    beforeUpdate: 'El documento solo se cambia en recepción.' },
//     },
//   };
//
// Why a value is protected at all: submitting this form may write back to the
// integrator's user database. Somebody saying a different name to a kiosk
// should not quietly rename their account.
//
//   (default)    a prefilled value the conversation may change freely
//   confirmOnly  a change is only proposed; `beforeUpdate` is explained and the
//                person has to say yes before it is written
//   readOnly     the conversation cannot change it; `beforeUpdate` says why.
//                Wins over confirmOnly. A staff correction still can.
//
// Protection belongs to the VALUE, not the field. A new visitor has nothing
// prefilled, so for them every field is an ordinary field.
//
// Everything here is pure: no agent, no socket.

import { checkField, isEmpty } from './validate.js';

const DEFAULT_CONFIRM = 'This value comes from their registered profile. Submitting a different one '
  + 'will also change it in their profile.';
const DEFAULT_READONLY = 'This value comes from their registered profile and cannot be changed here.';

/** What to tell the person when they try to change a protected value. */
export const explanation = (rule) =>
  rule.beforeUpdate || (rule.readOnly ? DEFAULT_READONLY : DEFAULT_CONFIRM);

/**
 * Mistakes in a form's `user` declaration. Found when the form loads, so an
 * integrator's typo fails a deploy rather than a visitor.
 */
export function userSchemaProblems(form) {
  const user = form.user;
  if (user === undefined || user === null) return [];

  const problems = [];
  if (typeof user !== 'object') return ['user: must be a schema object'];
  if (typeof user.key !== 'string' || !user.key) problems.push('user.key: must name the field that identifies a user');

  const props = user.properties;
  if (!props || typeof props !== 'object') return [...problems, 'user.properties: must be an object'];

  // The key identifies somebody in the integrator's database. The agent has
  // no use for it, and it is exactly what makes the rest of the record personal.
  if (props[user.key]?.prefill) problems.push(`user.${user.key}: the key can never be prefilled`);

  const formProps = form.schema?.properties || {};
  for (const [name, spec] of Object.entries(props)) {
    for (const flag of ['prefill', 'readOnly', 'confirmOnly']) {
      if (flag in spec && typeof spec[flag] !== 'boolean') problems.push(`user.${name}.${flag}: must be true or false`);
    }
    if ('beforeUpdate' in spec && typeof spec.beforeUpdate !== 'string') {
      problems.push(`user.${name}.beforeUpdate: must be text`);
    }

    const target = formProps[name];
    if (!spec.prefill || !target) continue;       // not a field this form has
    if (spec.type && target.type && spec.type !== target.type) {
      problems.push(`user.${name}: is ${spec.type} but the form's ${name} is ${target.type}`);
    }
    // Captured by the kiosk, never supplied: a stored photo would sit in `data`,
    // and `data` is restated to the model on every change.
    if (target.client) problems.push(`user.${name}: the form's ${name} is captured by the client and cannot be prefilled`);
  }
  return problems;
}

/**
 * A user record in, an arrival out — or the reasons it is refused.
 *
 * The record is checked against the user schema AND, for every field it
 * prefills, against the form's own field, because that is where the value
 * lands. Anything wrong refuses the whole arrival: a record that does not fit
 * is the integrator's to fix, and prefilling half of it would hide that.
 *
 * `extra` holds whatever the record carries that neither schema knows about.
 * The camera uses it for context notes; everything the user schema knows but
 * does not prefill stays private and goes nowhere.
 */
export function fromUser(form, record) {
  const user = form.user;
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, problems: ['user: expected a record'] };
  }

  const problems = [];
  const key = record[user.key];
  if (isEmpty(key) || (typeof key !== 'string' && typeof key !== 'number')) {
    problems.push(`${user.key}: missing — every user needs one`);
  }

  for (const name of user.required || []) {
    if (isEmpty(record[name])) problems.push(`${name}: required by the user schema`);
  }

  const formProps = form.schema?.properties || {};
  const prefill = {};
  const protect = {};
  const extra = {};

  for (const [name, value] of Object.entries(record)) {
    const spec = user.properties[name];
    if (name === user.key) continue;
    if (!spec) {
      if (!(name in formProps)) extra[name] = value;
      continue;
    }
    if (isEmpty(value)) continue;

    problems.push(...checkField(name, spec, value));
    const target = formProps[name];
    if (!spec.prefill || !target) continue;

    problems.push(...checkField(name, target, value));
    prefill[name] = value;
    if (spec.readOnly || spec.confirmOnly) {
      protect[name] = {
        readOnly: !!spec.readOnly,
        confirmOnly: !spec.readOnly && !!spec.confirmOnly,
        beforeUpdate: spec.beforeUpdate || '',
        value,
      };
    }
  }

  if (problems.length) return { ok: false, key: isEmpty(key) ? null : key, problems: [...new Set(problems)] };

  return {
    ok: true,
    person: {
      origin: 'known',
      personKey: key,
      // The name follows the form, not the record: once somebody confirms a new
      // one, that is what they should be called.
      label: '',
      prefill,
      protect,
      notes: '',
    },
    extra,
  };
}

/**
 * Somebody is here to fill the form, and this is who they are — or nobody
 * knows, which is a new user. The one entry point every connector shares: the
 * camera, an integrator's API call, a test.
 */
export function arrival(form, record = null) {
  if (record === null || record === undefined) {
    return { ok: true, person: { origin: 'unknown', personKey: null, label: '', prefill: {}, notes: '' } };
  }
  if (!form.user) return { ok: false, problems: ['this form has no user schema'] };
  return fromUser(form, record);
}

/**
 * Is `next` really a different value from `current`? A visitor saying "luis"
 * where the profile says "Luis" has not asked to change anything, and must not
 * be asked to confirm that they did.
 */
export function sameValue(a, b) {
  // Tagged by type, so the number 3 and the text "3" never compare equal.
  const norm = (v) => (typeof v === 'string'
    ? `s:${v.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase()}`
    : `j:${JSON.stringify(v)}`);
  return norm(a) === norm(b);
}

/**
 * Was `quote` really said, somewhere in `said`?
 *
 * The model reports the words a visitor answered with; the engine holds that
 * report against what was transcribed. Both are rough copies of the same
 * speech — the model heard the audio, the transcriber wrote it down — so
 * accents, capitals and punctuation are ignored, and a longer quote may miss
 * one word in five. What it may not do is be somebody else's sentence: every
 * word it keeps must appear in `said`, in order. Three words or fewer must all
 * be there.
 */
export function grounded(quote, said) {
  const words = (v) => (typeof v === 'string' ? v : '')
    .normalize('NFD').replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim().split(' ').filter(Boolean);
  const q = words(quote);
  const s = words(said);
  if (!q.length || !s.length) return false;

  // Longest common subsequence, by words.
  let prev = new Array(s.length + 1).fill(0);
  for (const w of q) {
    const cur = [0];
    for (let j = 1; j <= s.length; j++) {
      cur[j] = w === s[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  const kept = prev[s.length];
  return q.length <= 3 ? kept === q.length : kept >= Math.ceil(0.8 * q.length);
}
