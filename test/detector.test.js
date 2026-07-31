// The camera adapter. Offline: no socket, no model, no agent.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import visit from '../forms/visit.js';
import { planFromSnapshot, toPerson } from '../src/detector.js';

const VICTOR = {
  track_id: 3, posicion: 'derecha', persona_id: 'p_a1b2c3d4',
  visitante: 'Víctor Dávalos', procedencia: 'Dominos',
  anfitrion: 'Amalia Gastelum', visitas_previas: 4,
};

const snap = (conocidos = [], desconocidos = []) =>
  ({ type: 'people_detected', total: conocidos.length + desconocidos.length, conocidos, desconocidos });

/** Stand-in for the agent's registration records. */
const reg = (id, over = {}) => [id, {
  id, label: '', origin: 'unknown', personKey: null, status: 'open',
  state: { data: {}, missing: () => [] }, ...over,
}];

const known = (id, personKey, label) => reg(id, { origin: 'known', personKey, label });

describe('reading a detected person', () => {
  test('splits the event by what the form knows', () => {
    const p = toPerson(VICTOR, visit);
    assert.deepEqual(p.prefill, {
      visitante: 'Víctor Dávalos', procedencia: 'Dominos', anfitrion: 'Amalia Gastelum',
    });
    assert.equal(p.label, 'Víctor Dávalos');
    assert.equal(p.personKey, 'p_a1b2c3d4');
    assert.equal(p.origin, 'known');
  });

  test('anything the form does not know becomes context, and the id is neither', () => {
    const p = toPerson(VICTOR, visit);
    assert.match(p.notes, /visitas_previas: 4/);
    assert.match(p.notes, /track_id/);
    assert.doesNotMatch(p.notes, /persona_id/);
    assert.equal(p.prefill.persona_id, undefined);
  });
});

describe('what changed since the last snapshot', () => {
  test('a first sighting is an arrival', () => {
    const plan = planFromSnapshot(snap([VICTOR]), visit, new Map());
    assert.equal(plan.arrived.length, 1);
    assert.equal(plan.arrived[0].label, 'Víctor Dávalos');
    assert.equal(plan.departed.length, 0);
  });

  // The camera fires continuously. If a repeated snapshot produced an arrival
  // the agent would greet the same person on every frame.
  test('the same person again produces nothing', () => {
    const held = new Map([known('r1', 'p_a1b2c3d4', 'Víctor Dávalos')]);
    const plan = planFromSnapshot(snap([VICTOR]), visit, held);
    assert.deepEqual(plan, { arrived: [], departed: [], unidentifiedLeft: 0 });
  });

  test('a stranger joining a known visitor is one unidentified arrival', () => {
    const held = new Map([known('r1', 'p_a1b2c3d4', 'Víctor Dávalos')]);
    const plan = planFromSnapshot(snap([VICTOR], [{}]), visit, held);
    assert.equal(plan.arrived.length, 1);
    assert.equal(plan.arrived[0].origin, 'unknown');
    assert.equal(plan.arrived[0].label, '');
    assert.equal(plan.departed.length, 0);
  });

  test('the stranger leaving is counted, not named', () => {
    const held = new Map([known('r1', 'p_a1b2c3d4', 'Víctor Dávalos'), reg('r2')]);
    const plan = planFromSnapshot(snap([VICTOR]), visit, held);
    assert.equal(plan.unidentifiedLeft, 1);
    assert.equal(plan.arrived.length, 0);
    assert.equal(plan.departed.length, 0);
  });

  test('a known visitor leaving is named', () => {
    const held = new Map([known('r1', 'p_a1b2c3d4', 'Víctor Dávalos'), reg('r2')]);
    const plan = planFromSnapshot(snap([], [{}]), visit, held);
    assert.equal(plan.departed.length, 1);
    assert.equal(plan.departed[0].id, 'r1');
    assert.equal(plan.unidentifiedLeft, 0);
  });

  test('two strangers down to one leaves one behind', () => {
    const held = new Map([reg('r1'), reg('r2')]);
    const plan = planFromSnapshot(snap([], [{}]), visit, held);
    assert.equal(plan.unidentifiedLeft, 1);
    assert.equal(plan.arrived.length, 0);
  });

  test('an empty room retires everybody', () => {
    const held = new Map([known('r1', 'p_a1b2c3d4', 'Víctor Dávalos'), reg('r2')]);
    const plan = planFromSnapshot(snap(), visit, held);
    assert.equal(plan.departed.length, 1);
    assert.equal(plan.unidentifiedLeft, 1);
  });
});

describe('never a second form for the same person', () => {
  test('somebody who already finished is not registered again', () => {
    const held = new Map([known('r1', 'p_a1b2c3d4', 'Víctor Dávalos', {})]);
    held.get('r1').status = 'submitted';
    const plan = planFromSnapshot(snap([VICTOR]), visit, held);
    assert.equal(plan.arrived.length, 0, 'standing in the lobby after registering is not an arrival');
  });

  // Otherwise: agent closes the form, camera still sees them, we reopen, the
  // agent asks again — forever.
  test('a closed form is not silently reopened', () => {
    const held = new Map([known('r1', 'p_a1b2c3d4', 'Víctor Dávalos')]);
    held.get('r1').status = 'closed';
    const plan = planFromSnapshot(snap([VICTOR]), visit, held);
    assert.equal(plan.arrived.length, 0);
  });

  test('a different person with the same id is still one person', () => {
    const held = new Map([known('r1', 'p_a1b2c3d4', 'Víctor Dávalos')]);
    const renamed = { ...VICTOR, visitante: 'Víctor D. Dávalos' };
    assert.equal(planFromSnapshot(snap([renamed]), visit, held).arrived.length, 0);
  });
});

describe('events we do not act on', () => {
  test('scene_empty changes nothing for now', () => {
    const held = new Map([known('r1', 'p_a1b2c3d4', 'Víctor Dávalos')]);
    assert.deepEqual(planFromSnapshot({ type: 'scene_empty' }, visit, held),
      { arrived: [], departed: [], unidentifiedLeft: 0 });
  });
});
