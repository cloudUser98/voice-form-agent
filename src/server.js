// WebSocket transport. One connection = one conversation.
//
// Binary frames are PCM16 mono 24kHz audio, in both directions.
// Text frames are JSON control/events.
//
//   client -> {type:'start', form, notes?, mode?, debug?}   arms the session
//   client -> {type:'text', text}          typed input instead of speech
//   client -> {type:'correct', registration?, field, value}  human overrules
//   client -> {type:'detected', event}   a raw snapshot, if the client owns the camera
//   server -> {type:'waiting'}   armed; nobody is in the room yet
//   server -> {type:'ready'|'transcript'|'state'|'idle'|'speaking'|'flush'|'done'|'error'}
//   server -> {type:'debug', entry}   every event, when start asked for it
//
// `start` only arms the session. The realtime connection is opened by the
// first person the camera reports, so a kiosk facing an empty lobby overnight
// holds no session at all.
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
  let config = null;                  // what to build once somebody shows up
  let detector = null;
  const say = (obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));

  ws.on('message', async (data, isBinary) => {
    if (isBinary) return agent?.sendAudio(data);

    let msg;
    try { msg = JSON.parse(data); } catch { return say({ type: 'error', error: 'invalid json' }); }

    if (msg.type === 'start') {
      if (config) return say({ type: 'error', error: 'already started' });
      try {
        config = {
          form: await loadForm(msg.form),
          mode: msg.mode === 'text' ? 'text' : 'audio',
          notes: msg.notes || '',
          debug: !!msg.debug,
        };
      } catch (err) {
        return say({ type: 'error', error: String(err.message || err) });
      }
      watchDetector();
      return say({ type: 'waiting', form: msg.form });
    }

    // A raw snapshot forwarded by a client that owns the camera itself. Allowed
    // before an agent exists — it is the thing that creates one.
    if (msg.type === 'detected') return feed(msg.event);

    if (!agent) return say({ type: 'error', error: 'nobody has arrived at reception yet' });
    if (msg.type === 'text') return agent.sendText(msg.text);
    if (msg.type === 'correct') {
      const r = agent.correct(msg.field, msg.value, msg.registration);
      return r.ok || say({ type: 'error', error: r.error });
    }
    say({ type: 'error', error: `unknown message ${msg.type}` });
  });

  /**
   * Raw detector snapshot in, agent instructions out — and the session itself
   * if this is the first person through the door. An empty room never opens one.
   */
  function feed(event) {
    if (!config) return;
    say({ type: 'detected', event });                 // straight into the inspector

    const plan = planFromSnapshot(event, config.form, agent ? agent.registrations : new Map());

    if (!agent) {
      if (!plan.arrived.length) return;               // nobody there; stay asleep
      agent = build();
      agent.start();
    }
    // Fires ~400ms before the session is ready; roomUpdate queues it and drains
    // on session.updated.
    agent.roomUpdate(plan);
  }

  function build() {
    const a = new FormAgent({ form: config.form, notes: config.notes, mode: config.mode });
    a.on('open', () => say({ type: 'ready', session: a.sessionId, trace: a.trace.file }));
    a.on('audio', (buf) => ws.readyState === ws.OPEN && ws.send(buf, { binary: true }));
    a.on('transcript', (m) => say({ type: 'transcript', ...m }));
    a.on('state', (s) => say({ type: 'state', ...s }));
    a.on('idle', () => say({ type: 'idle' }));
    a.on('speaking', (on) => say({ type: 'speaking', on }));
    a.on('focus', (f) => say({ type: 'focus', ...f }));
    a.on('flush', () => say({ type: 'flush' }));
    a.on('done', (d) => say({ type: 'done', ...d }));
    a.on('error', (e) => say({ type: 'error', error: String(e.message || e) }));
    a.on('close', () => ws.close());
    if (config.debug) a.on('debug', (entry) => say({ type: 'debug', entry }));
    return a;
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
