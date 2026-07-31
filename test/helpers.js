import { FormAgent } from '../src/agent.js';

/**
 * Runs a scripted conversation in text mode against the real API and returns
 * the transcript plus the final form state. This is the whole test strategy:
 * no mocks, no unit-testing a state machine that no longer exists.
 */
export function converse(form, lines, { prefill, notes, label, timeoutMs = 90000, verbose } = {}) {
  return new Promise((resolve, reject) => {
    const agent = new FormAgent({ form, prefill, notes, label, mode: 'text' });
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
  });
}
