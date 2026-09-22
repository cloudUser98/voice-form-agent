import { FormAgent } from '../src/agent.js';

/** The least a spec will accept. Field names make a failing trace readable. */
function sample(name, spec = {}) {
  if (spec.enum) return spec.enum[0];
  if (spec.type === 'integer' || spec.type === 'number') return Math.max(spec.minimum ?? 1, 1);
  if (spec.type === 'boolean') return true;
  if (spec.type === 'array') {
    return Array.from({ length: spec.minItems || 1 }, () => sample(name, spec.items));
  }
  return name.padEnd(spec.minLength || 0, 'x').slice(0, spec.maxLength || undefined);
}

/**
 * Everything a form needs to be complete, worked out from its own schema.
 *
 * Most of the suite is about handover, session end, tool modes or id
 * resolution, and needs a full registration only to get at what happens next.
 * None of it needs to know what a visit contains. A literal here is a fixture
 * that goes stale the day a form grows a field — and takes thirty unrelated
 * assertions down with it, which is exactly what `foto` did.
 *
 * Fields the client owns are left out: speech cannot fill them and save_fields
 * refuses them, so use `withoutClient` for a form that talking alone can
 * finish. `overrides` is for a field whose actual value is the subject of the
 * test, like a host the directory has to recognise.
 */
export const fill = (form, overrides = {}) => ({
  ...Object.fromEntries(
    (form.schema.required || [])
      .filter((f) => !form.schema.properties?.[f]?.client)
      .map((f) => [f, sample(f, form.schema.properties?.[f])]),
  ),
  ...overrides,
});

/** The same form with nothing on it that the client has to capture. */
export const withoutClient = (form) => ({
  ...form,
  tools: (form.tools || []).filter((t) => t.definition.name !== 'take_photo'),
  schema: {
    ...form.schema,
    properties: Object.fromEntries(
      Object.entries(form.schema.properties).filter(([, spec]) => !spec.client),
    ),
    required: (form.schema.required || [])
      .filter((f) => !form.schema.properties?.[f]?.client),
  },
});

/**
 * Runs a scripted conversation in text mode against the real API and returns
 * the transcript plus the final form state. This is the whole test strategy:
 * no mocks, no unit-testing a state machine that no longer exists.
 */
export function converse(form, lines, { prefill, notes, label, user, timeoutMs = 90000, verbose, onRequest } = {}) {
  return new Promise((resolve, reject) => {
    const agent = new FormAgent({ form, notes, mode: 'text' });
    const script = [...lines];
    const transcript = [];
    let last = { data: prefill ? { ...prefill } : {}, missing: [] };
    const registrations = new Map();
    let done = null;

    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    function finish(reason) {
      clearTimeout(timer);
      agent.close();
      resolve({
        transcript,
        data: last.data,
        missing: last.missing,
        evidence: last.evidence || {},
        registrations: Object.fromEntries(registrations),
        done,
        reason,
      });
    }

    agent.on('transcript', (m) => {
      transcript.push(m);
      if (verbose) console.log(`  ${m.role === 'user' ? '👤' : '🤖'} ${m.text}`);
    });
    agent.on('state', (s) => { last = s; if (s.registration) registrations.set(s.registration, s); });
    agent.on('done', (d) => { done = d; setTimeout(() => finish('submitted'), 1500); });
    agent.on('error', (e) => { clearTimeout(timer); agent.close(); reject(e); });

    // Play the client. Registering a listener at all is what makes ask() wait
    // for one — without this the agent answers itself with nothing, which is
    // what lets every other test here run with no client at the other end.
    if (onRequest) agent.on('request', (r) => agent.answer(r.id, onRequest(r)));

    agent.on('idle', () => {
      if (done) return;
      // A script entry may be a function — that is how a test plays the part of
      // a staff member correcting a field, or of someone walking in. If the
      // action asks the agent to speak, it gets the turn and the next spoken
      // line waits for the turn after.
      while (script.length && typeof script[0] === 'function') {
        script.shift()(agent);
        if (agent.responsePending) return;
      }
      const next = script.shift();
      if (next === undefined) return finish('script-exhausted');
      transcript.push({ role: 'user', text: next });
      if (verbose) console.log(`  👤 ${next}`);
      agent.sendText(next);
    });

    agent.start();
    // Nothing happens until the room says somebody is there. A scripted person
    // talking implies a person present, so put one there.
    // `user` is somebody the integrator already knows: they arrive through the
    // same door every connector uses, user schema and all.
    agent.once('open', () => user ? agent.arrive(user) : agent.roomUpdate({
      arrived: [{ origin: label ? 'known' : 'unknown', personKey: label || null,
                  label: label || '', prefill: prefill || {}, notes: '' }],
    }));
  });
}
