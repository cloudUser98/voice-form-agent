// Terminal client. Proof the agent is transport-agnostic, and the fastest dev
// loop there is: type at the agent, watch the form fill.
//
//   node clients/cli.js visit
//   node clients/cli.js hotel --notes "La cámara reconoció a Víctor Delgado."
import 'dotenv/config';
import readline from 'node:readline';
import WebSocket from 'ws';

const args = process.argv.slice(2);
const form = args[0] || 'visit';
const notes = args.includes('--notes') ? args[args.indexOf('--notes') + 1] : '';
const url = process.env.AGENT_URL || 'ws://localhost:8787';

const ws = new WebSocket(url);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '👤 ' });

// Lines are queued and released one per agent turn, so piping a script in
// works the same as typing interactively.
const queue = [];
let waiting = false;

function pump() {
  if (!waiting || !queue.length) return;
  waiting = false;
  ws.send(JSON.stringify({ type: 'text', text: queue.shift() }));
}

ws.on('open', () => ws.send(JSON.stringify({ type: 'start', form, notes, mode: 'text' })));

ws.on('message', (raw, isBinary) => {
  if (isBinary) return;                       // a real client would play this
  const e = JSON.parse(raw);
  if (e.type === 'ready') {
    console.log(`— session ${e.session} · trace ${e.trace}`);
    console.log('  /arrive <name> · /arrive · /leave <name> · /empty\n');
    room.desconocidos.push({});           // somebody walks up, so it wakes
    snapshot();
  }
  if (e.type === 'transcript' && e.role === 'agent') console.log(`🤖 ${e.text}\n`);
  if (e.type === 'state') console.log(`   [${e.registration} ${e.label || '(sin nombre)'} · missing: ${e.missing.join(', ') || 'nothing'}]`);
  if (e.type === 'done') console.log(`✅ ${e.registration} ${e.label || ''} ${JSON.stringify(e.result)}\n${JSON.stringify(e.data, null, 2)}`);
  if (e.type === 'error') console.error(`⚠️  ${e.error}`);
  if (e.type === 'idle') { waiting = true; queue.length ? pump() : rl.prompt(); }
});

// The room drives everything now, so hold a snapshot and mutate it by hand:
//   /arrive Ana Ruiz   /arrive            (unidentified)
//   /leave  Ana Ruiz   /empty
const room = { type: 'people_detected', conocidos: [], desconocidos: [] };
const snapshot = () => {
  room.total = room.conocidos.length + room.desconocidos.length;
  ws.send(JSON.stringify({ type: 'detected', event: room }));
};

rl.on('line', (line) => {
  const cmd = line.match(/^\/(arrive|leave|empty)\s*(.*)$/);
  if (cmd) {
    const [, verb, who] = cmd;
    if (verb === 'empty') { room.conocidos = []; room.desconocidos = []; }
    else if (verb === 'leave') room.conocidos = room.conocidos.filter((p) => p.visitante !== who.trim());
    else if (who.trim()) room.conocidos.push({ persona_id: `p_${who.trim()}`, visitante: who.trim() });
    else room.desconocidos.push({});
    return snapshot();
  }
  if (line.trim()) { queue.push(line); pump(); }
});
rl.on('close', () => { if (!queue.length && !waiting) ws.close(); });
ws.on('close', () => { rl.close(); process.exit(0); });
ws.on('error', (e) => { console.error(`cannot reach ${url}: ${e.message}`); process.exit(1); });
