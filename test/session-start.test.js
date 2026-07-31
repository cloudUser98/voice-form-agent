// The only test that needs a real socket: it spawns the server and checks that
// an empty lobby never opens a realtime session. A kiosk left running
// overnight must cost nothing until somebody actually walks up.
import 'dotenv/config';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = 8790 + Math.floor(Math.random() * 200);
let server;

const connect = () => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  ws.on('open', () => resolve(ws));
  ws.on('error', reject);
});

/** Collect messages for a while, then hand back what arrived. */
function collect(ws, ms) {
  const seen = [];
  const onMessage = (raw, isBinary) => { if (!isBinary) seen.push(JSON.parse(raw)); };
  ws.on('message', onMessage);
  return new Promise((r) => setTimeout(() => { ws.off('message', onMessage); r(seen); }, ms));
}

const snapshot = (conocidos = [], desconocidos = []) => ({
  type: 'detected',
  event: { type: 'people_detected', total: conocidos.length + desconocidos.length, conocidos, desconocidos },
});

before(async () => {
  server = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(PORT), DETECTOR_URL: `ws://localhost:${PORT + 1000}` },
    stdio: 'ignore',
  });
  await new Promise((r) => setTimeout(r, 900));         // let it bind
});

after(() => server?.kill());

describe('the session starts with the room, not with the client', () => {
  test('arming it opens no realtime session', async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'start', form: 'visit', mode: 'text' }));
    const seen = await collect(ws, 1500);
    ws.close();

    assert.ok(seen.some((m) => m.type === 'waiting'), 'should confirm it is armed');
    assert.equal(seen.filter((m) => m.type === 'ready').length, 0,
      'no session should exist while the lobby is empty');
  });

  test('a snapshot of an empty room still opens nothing', async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'start', form: 'visit', mode: 'text' }));
    await collect(ws, 300);

    ws.send(JSON.stringify(snapshot()));                // camera sees nobody
    const seen = await collect(ws, 1500);
    ws.close();

    assert.equal(seen.filter((m) => m.type === 'ready').length, 0);
  });

  test('talking before anyone arrives is refused, not crashed', async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'start', form: 'visit', mode: 'text' }));
    await collect(ws, 300);

    ws.send(JSON.stringify({ type: 'text', text: '¿hola?' }));
    const seen = await collect(ws, 800);
    ws.close();

    const err = seen.find((m) => m.type === 'error');
    assert.match(err?.error || '', /nobody has arrived/);
  });

  test('somebody walking in starts the session and the conversation', {
    skip: process.env.OPENAI_API_KEY ? false : 'no OPENAI_API_KEY',
    timeout: 40000,
  }, async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'start', form: 'visit', mode: 'text' }));
    await collect(ws, 300);

    ws.send(JSON.stringify(snapshot([], [{}])));        // one unidentified visitor
    const seen = await collect(ws, 12000);
    ws.close();

    assert.ok(seen.some((m) => m.type === 'ready'), 'the arrival should open the session');
    assert.ok(seen.some((m) => m.type === 'transcript' && m.role === 'agent'),
      'and the agent should greet them');
  });
});
