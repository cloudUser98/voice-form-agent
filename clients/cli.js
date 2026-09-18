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

// A terminal has neither a camera nor a reader, so it plays both parts. The
// agent does not care what a photo or a code is, only that something came back
// — but the endpoints at the far end do, so the stand-ins are real-shaped: a
// genuine one-pixel JPEG, and a string of the sort their system prints.
//
// CODE is what a scanned QR decodes to, and that is all a reader ever hands
// over — the visit behind it is looked up server-side. Try another:
//   CODE='CITA-0000' node clients/cli.js visit      (a code nobody knows)
//   CODE='' node clients/cli.js visit               (the reader read nothing)
const CODE = process.env.CODE ?? 'CITA-1234';

// 1x1 JPEG, for standing in as whatever a real client's camera would produce.
const PIXEL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJ'
  + 'CQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAAB'
  + 'AAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

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

// Say what this client can be asked for. A tool needing anything else is never
// shown to the model, so the agent cannot offer what a terminal cannot do.
ws.on('open', () => ws.send(JSON.stringify({
  type: 'start', form, notes, mode: 'text', capabilities: ['photo', 'code'],
})));

ws.on('message', (raw, isBinary) => {
  if (isBinary) return;                       // a real client would play this
  const e = JSON.parse(raw);
  // 'ready' now only arrives once somebody is in the room, so the opening
  // arrival has to be sent as soon as the session is armed.
  if (e.type === 'waiting') {
    console.log('  /arrive <name> · /arrive · /leave <name> · /empty\n');
    room.desconocidos.push({});           // somebody walks up, so it wakes
    snapshot();
  }
  if (e.type === 'ready') console.log(`— session ${e.session} · trace ${e.trace}\n`);
  if (e.type === 'transcript' && e.role === 'agent') console.log(`🤖 ${e.text}\n`);
  if (e.type === 'state') console.log(`   [${e.registration} ${e.label || '(sin nombre)'} · missing: ${e.missing.join(', ') || 'nothing'}]`);
  if (e.type === 'done') console.log(`✅ ${e.registration} ${e.label || ''} ${JSON.stringify(e.result)}\n${JSON.stringify(e.data, null, 2)}`);
  // Answer by kind. An unknown kind is answered with null rather than left
  // hanging: the agent waits on `ask` with no deadline, and a client that goes
  // quiet is indistinguishable from one that is still thinking about it.
  if (e.type === 'request') {
    console.log(`   [client: ${e.kind} for ${e.registration || '?'}]`);
    const value = e.kind === 'photo' ? PIXEL : e.kind === 'code' ? CODE : null;
    ws.send(JSON.stringify({ type: 'answer', id: e.id, value }));
  }
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
