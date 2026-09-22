// Adapter for the external face-recognition service.
//
// Everything that knows the words `people_detected`, `conocidos` and
// `desconocidos` lives here and nowhere else. To swap detectors, rewrite
// planFromSnapshot and change one import — the agent and the server do not move.
//
// The service sends full snapshots of who is in the room, never deltas, so a
// departure is only ever the *absence* of somebody from the next snapshot.

import { fromUser } from './user.js';

/** The event field that identifies a person. Not data, not context. */
const ID = 'persona_id';

const context = (extra) => Object.entries(extra).map(([k, v]) => `${k}: ${v}`).join(', ');

/**
 * Split a detected person into what the form can use and what it cannot.
 * Any key the schema knows becomes prefill; anything else becomes context. No
 * per-form configuration — a hotel form works the same with no code change.
 */
export function toPerson(person, form) {
  // A form that declares its user reads the detection as that user's record:
  // only what the user schema prefills lands in the form, and a record that
  // does not fit is refused — the server reports it once and serves nobody.
  if (form.user) {
    const r = fromUser(form, person);
    if (!r.ok) {
      return {
        origin: 'known', personKey: r.key ?? person[form.user.key] ?? null,
        refused: r.problems, label: '', prefill: {}, notes: '',
      };
    }
    // Whatever neither schema knows is context for the greeting, as it always
    // was. What the user schema knows but does not prefill stays private.
    return { ...r.person, notes: context(r.extra) };
  }

  const props = form.schema.properties || {};
  const prefill = {};
  const extra = {};

  for (const [key, value] of Object.entries(person)) {
    if (key === ID) continue;
    (key in props ? prefill : extra)[key] = value;
  }

  return {
    origin: 'known',
    personKey: person[ID] ?? null,
    label: prefill[form.labelFrom] || '',
    prefill,
    notes: context(extra),
  };
}

/**
 * What changed between the room the agent is holding and the one the camera
 * just reported.
 *
 * Known people are matched by id across EVERY registration, whatever its state:
 * a camera that keeps reporting somebody must never spawn a second form for
 * them, and a form the agent closed must never silently reopen itself.
 *
 * Unidentified people have no id to match on, so they are counted — two
 * strangers in the room means two registrations, and if the count drops we know
 * somebody left but not which one.
 */
 export function planFromSnapshot(roomEvent, form, registrations) {
     if (!roomEvent || roomEvent.type !== 'people_detected') {
         return { arrived: [], departed: [], unidentifiedLeft: 0 };
     }

     const ongoingForms = [...registrations.values()];
     const seen = (roomEvent.conocidos || []).map((p) => toPerson(p, form));

     const heldKnown = ongoingForms.filter((r) => r.status === 'open' && r.origin === 'known');
     const heldUnknown = ongoingForms.filter((r) => r.status === 'open' && r.origin === 'unknown');

     const strangers = (roomEvent.desconocidos || []).length;
     return {
         arrived: [
             ...seen.filter((p) => !ongoingForms.some((f) => f.personKey && f.personKey === p.personKey)),
             ...Array.from(
                 { length: Math.max(0, strangers - heldUnknown.length) },
                 () => ({ origin: 'unknown', personKey: null, label: '', prefill: {}, notes: '' }),
             ),
         ],
         departed: heldKnown.filter((r) => !seen.some((p) => p.personKey === r.personKey)),
         unidentifiedLeft: Math.max(0, heldUnknown.length - strangers),
     };
 }
