// Offline: no socket, no API key spent. Drives the agent by handing it server
// events directly, which is also how a recorded trace can be replayed.
process.env.TRACE = 'off';

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import visit from '../forms/visit.js';
import { FormAgent } from '../src/agent.js';

const agent = () => new FormAgent({ form: visit, mode: 'text', apiKey: 'test-key' });

const spoken = (id, text, status = 'completed') => ({
  type: 'response.done',
  response: { id, status, output: [{ type: 'message', content: [{ transcript: text }] }] },
});

describe('response.done deduplication', () => {
  test('a cancel echo of a finished response does not repeat the line', () => {
    const a = agent();
    const said = [];
    a.on('transcript', (m) => said.push(m.text));

    // Exactly what the server sent when the visitor talked over the agent:
    // the same response id reported twice, once completed, once cancelled.
    a.handleEvent(spoken('resp_1', 'Listo, ya quedó tu registro.'));
    a.handleEvent(spoken('resp_1', 'Listo, ya quedó tu registro.', 'cancelled'));

    assert.deepEqual(said, ['Listo, ya quedó tu registro.']);
  });

  test('genuinely different responses are both reported', () => {
    const a = agent();
    const said = [];
    a.on('transcript', (m) => said.push(m.text));

    a.handleEvent(spoken('resp_1', 'Hola, ¿tu nombre?'));
    a.handleEvent(spoken('resp_2', 'Gracias, ¿de dónde vienes?'));

    assert.deepEqual(said, ['Hola, ¿tu nombre?', 'Gracias, ¿de dónde vienes?']);
  });

  test('a response with no id is still reported', () => {
    const a = agent();
    const said = [];
    a.on('transcript', (m) => said.push(m.text));

    a.handleEvent({
      type: 'response.done',
      response: { status: 'completed', output: [{ type: 'message', content: [{ transcript: 'Hola' }] }] },
    });

    assert.deepEqual(said, ['Hola']);
  });

  test('idle fires once per response, not once per duplicate', () => {
    const a = agent();
    let idles = 0;
    a.on('idle', () => { idles += 1; });

    a.handleEvent(spoken('resp_1', 'Hola'));
    a.handleEvent(spoken('resp_1', 'Hola', 'cancelled'));

    assert.equal(idles, 1);
  });
});
