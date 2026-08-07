// How a tool behaves while it is running.
//
// An undecorated tool is awaited inline, exactly as it always was. Decorating
// one only changes what happens during the wait:
//
//   blocking   — she says "let me go check" and walks away. The microphone
//                stays shut until she is back.
//   deferred   — she carries on chatting, then cuts in with the answer.
//   background — she files it and never mentions it again.
//
//   import { blocking } from '../src/tools.js';
//
//   submit: blocking(async (data) => (await save(data)).folio, {
//     say: 'Dile que estás guardando el registro y que espere un momento.',
//   })
//
// Options, all optional:
//   say          what to say while it runs, if it runs long enough to notice.
//                A function receives the tool's own arguments, so the cover
//                sentence can name what is being looked up.
//   done(result) what to say when it succeeds   — `deferred` only
//   fail(error)  what to say when it fails      — `deferred` only
//   timeoutMs    give up waiting after this (default 40s)
//   coverAfterMs only bother speaking if it takes longer than this (default 400ms)
//
// `done` and `fail` do nothing for `blocking`, because there the real result
// and any error travel back to the model as the tool's own output and it
// reacts to them itself.

const MODE = Symbol('tool-mode');
const DEFAULTS = { timeoutMs: 40000, coverAfterMs: 400 };

const mark = (fn, meta) =>
  Object.assign((...args) => fn(...args), { [MODE]: { ...DEFAULTS, ...meta } });

export const blocking = (fn, o = {}) => mark(fn, { hold: true, ...o });
export const deferred = (fn, o = {}) => mark(fn, { hold: false, announce: true, ...o });
export const background = (fn, o = {}) => mark(fn, { hold: false, announce: false, ...o });

export const modeOf = (fn) => fn?.[MODE] || null;

/** Stop waiting after `ms`. The work carries on; we just stop caring about it. */
export function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`tool timed out after ${ms}ms`)), ms);
    }),
  ]);
}
