import { FormAgent } from '../src/agent.js';

/**
 * Runs a scripted conversation in text mode against the real API and returns
 * the transcript plus the final form state. This is the whole test strategy:
 * no mocks, no unit-testing a state machine that no longer exists.
 */
export function converse(form, lines, { prefill, notes, timeoutMs = 90000, verbose } = {}) {
  return new Promise((resolve, reject) => {
    const agent = new FormAgent({ form, prefill, notes, mode: 'text' });
    const script = [...lines];
    const transcript = [];
    let last = { data: prefill ? { ...prefill } : {}, missing: [] };
    let done = null;

    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    function finish(reason) {
      clearTimeout(timer);
      agent.close();
      resolve({ transcript, data: last.data, missing: last.missing, done, reason });
    }

    agent.on('transcript', (m) => {
      transcript.push(m);
      if (verbose) console.log(`  ${m.role === 'user' ? '👤' : '🤖'} ${m.text}`);
    });
    agent.on('state', (s) => { last = s; });
    agent.on('done', (d) => { done = d; setTimeout(() => finish('submitted'), 1500); });
    agent.on('error', (e) => { clearTimeout(timer); agent.close(); reject(e); });

    agent.on('idle', () => {
      if (done) return;
      const next = script.shift();
      if (next === undefined) return finish('script-exhausted');
      transcript.push({ role: 'user', text: next });
      if (verbose) console.log(`  👤 ${next}`);
      agent.sendText(next);
    });

    agent.start();
  });
}
