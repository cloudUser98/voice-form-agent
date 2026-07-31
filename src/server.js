// WebSocket transport. One connection = one conversation.
//
// Binary frames are PCM16 mono 24kHz audio, in both directions.
// Text frames are JSON control/events.
//
//   client -> {type:'start', form, prefill?, notes?, mode?}
//   client -> {type:'text', text}          typed input instead of speech
//   client -> {type:'correct', registration?, field, value}  human overrules
//   client -> {type:'detected', event}   a raw snapshot, if the client owns the camera
//   server -> {type:'ready'|'transcript'|'state'|'idle'|'speaking'|'flush'|'done'|'error'}
//   server -> {type:'debug', entry}   every event, when start asked for it
import 'dotenv/config';
import { WebSocketServer, WebSocket } from 'ws';
import { FormAgent } from './agent.js';
import { planFromSnapshot } from './detector.js';

const PORT = Number(process.env.PORT || 8787);
const FORMS = new Map();

async function loadForm(name) {
  if (!/^[a-z0-9-]+$/i.test(name)) throw new Error('bad form name');
  if (!FORMS.has(name)) {
    const mod = await import(new URL(`../forms/${name}.js`, import.meta.url));
    FORMS.set(name, mod.default);
  }
  return FORMS.get(name);
}

const wss = new WebSocketServer({ port: PORT });
console.log(`voice-form-agent listening on ws://localhost:${PORT}`);

wss.on('connection', (ws) => {
  let agent = null;
  let detector = null;
  const say = (obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));

  ws.on('message', async (data, isBinary) => {
    if (isBinary) return agent?.sendAudio(data);

    let msg;
    try { msg = JSON.parse(data); } catch { return say({ type: 'error', error: 'invalid json' }); }

    if (msg.type === 'start') {
      if (agent) return say({ type: 'error', error: 'already started' });
      try {
        const form = await loadForm(msg.form);
        agent = new FormAgent({
          form,
          prefill: msg.prefill || {},
          notes: msg.notes || '',
          mode: msg.mode === 'text' ? 'text' : 'audio',
        });
      } catch (err) {
        return say({ type: 'error', error: String(err.message || err) });
      }

      agent.on('open', () => say({ type: 'ready', session: agent.sessionId, trace: agent.trace.file }));
      agent.on('audio', (buf) => ws.readyState === ws.OPEN && ws.send(buf, { binary: true }));
      agent.on('transcript', (m) => say({ type: 'transcript', ...m }));
      agent.on('state', (s) => say({ type: 'state', ...s }));
      agent.on('idle', () => say({ type: 'idle' }));
      agent.on('speaking', (on) => say({ type: 'speaking', on }));
      agent.on('focus', (f) => say({ type: 'focus', ...f }));
      agent.on('flush', () => say({ type: 'flush' }));
      if (msg.debug) agent.on('debug', (entry) => say({ type: 'debug', entry }));
      agent.on('done', (d) => say({ type: 'done', ...d }));
      agent.on('error', (e) => say({ type: 'error', error: String(e.message || e) }));
      agent.on('close', () => ws.close());

      agent.start();
      watchDetector();
      return;
    }

    if (!agent) return say({ type: 'error', error: 'send {type:"start"} first' });
    if (msg.type === 'text') return agent.sendText(msg.text);
    if (msg.type === 'correct') {
      const r = agent.correct(msg.field, msg.value, msg.registration);
      return r.ok || say({ type: 'error', error: r.error });
    }
    // A raw snapshot forwarded by a client that owns the camera itself.
    if (msg.type === 'detected') return feed(msg.event);
    say({ type: 'error', error: `unknown message ${msg.type}` });
  });

  /** Raw detector snapshot in, agent instructions out. */
  function feed(event) {
    if (!agent) return;
    say({ type: 'detected', event });                 // straight into the inspector
    agent.roomUpdate(planFromSnapshot(event, agent.form, agent.registrations));
  }

  /**
   * The camera service is external and may not be running. Its absence must
   * never take the session down — it just means nobody is announced.
   */
  function watchDetector() {
    const url = process.env.DETECTOR_URL || 'ws://localhost:8765';
    try {
      detector = new WebSocket(url);
      detector.on('message', (raw) => { try { feed(JSON.parse(raw)); } catch { /* not ours */ } });
      detector.on('error', () => say({ type: 'error', error: `no detector at ${url}` }));
    } catch { /* nothing to watch */ }
  }

  ws.on('close', () => { agent?.close(); detector?.close(); });
});
