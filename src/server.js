// WebSocket transport. One connection = one conversation.
//
// Binary frames are PCM16 mono 24kHz audio, in both directions.
// Text frames are JSON control/events.
//
//   client -> {type:'start', form, prefill?, notes?, mode?}
//   client -> {type:'text', text}          typed input instead of speech
//   client -> {type:'interrupt'}
//   server -> {type:'ready'|'transcript'|'state'|'idle'|'interrupted'|'done'|'error'}
import 'dotenv/config';
import { WebSocketServer } from 'ws';
import { FormAgent } from './agent.js';

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
      agent.on('interrupted', () => say({ type: 'interrupted' }));
      agent.on('done', (d) => say({ type: 'done', ...d }));
      agent.on('error', (e) => say({ type: 'error', error: String(e.message || e) }));
      agent.on('close', () => ws.close());

      return agent.start();
    }

    if (!agent) return say({ type: 'error', error: 'send {type:"start"} first' });
    if (msg.type === 'text') return agent.sendText(msg.text);
    if (msg.type === 'interrupt') return agent.interrupt();
    say({ type: 'error', error: `unknown message ${msg.type}` });
  });

  ws.on('close', () => agent?.close());
});
