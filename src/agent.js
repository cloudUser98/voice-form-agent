import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { buildInstructions, buildTools, nextAction } from './prompt.js';
import { FormState } from './form-state.js';
import { modeOf, withTimeout } from './tools.js';
import { openTrace } from './trace.js';

const REALTIME_URL = 'wss://api.openai.com/v1/realtime';

/**
 * A headless voice agent that fills a form per person.
 *
 * It knows nothing about browsers, kiosks, cameras or avatars. Somebody else
 * watches the room and tells it who is there via roomUpdate(); until that
 * happens the agent is connected but silent.
 *
 * Events: 'open' | 'audio' (Buffer pcm16) | 'transcript' {role,text}
 *         'state' {data,missing} | 'focus' {registration} | 'idle'
 *         'speaking' bool | 'done' {data} | 'ended' {session}
 *         'flush' (drop buffered audio) | 'busy' bool (a tool has the floor)
 *         'request' {id,kind,...} (something only the client can do — answer())
 *         'debug' (every event) | 'error' | 'close'
 *
 * The conversation is half duplex: the agent never listens while it talks, and
 * is never interrupted.
 *
 * It also ends. When the last registration is finished with there is no work
 * left, so the agent says goodbye and closes its session rather than sitting
 * on an open socket facing an empty lobby. Whoever arrives next gets a new one.
 */
export class FormAgent extends EventEmitter {
    constructor({
        form,
        notes = '',
        maxOpen = 6,                        // guard against runaway registrations
        mode = 'audio',                     // 'audio' | 'text'
        apiKey = process.env.OPENAI_API_KEY,
        model = process.env.REALTIME_MODEL || 'gpt-realtime-2.1',
        voice = form?.voice || 'marin',
        sessionId = `s_${Date.now().toString(36)}`,
    } = {}) {
        super();
        if (!form) throw new Error('FormAgent needs a form definition');
        if (!apiKey) throw new Error('FormAgent needs an OpenAI API key');
    
        this.form = form;
        this.mode = mode;
        this.notes = notes;
        this.maxOpen = maxOpen;
    
        // Registrations exist because the room says a person exists. The model
        // never creates one, and none exist until the first detection arrives.
        this.registrations = new Map();
        this.nextId = 1;
        this.focused = null;
        this.greeted = false;
        this.pendingRoom = [];              // updates that beat the session handshake
    
        this.sessionId = sessionId;
        this.speaking = false;
        this.responsePending = false;       // we asked for a response, none finished yet
        this.queued = false;                // something wanted the floor while busy
        this.pendingNudge = false;          // a room event that still needs a reply
        this.busy = false;                  // a blocking tool has the floor
        this.audio = null;                  // the response currently being spoken
        this.truncatedItem = null;          // its deltas are stale; drop them
        this.ending = false;                // the last person is being said goodbye to
        this.ended = false;                 // ...and that is done; the session is over
        this.farewellDone = false;          // the goodbye has been asked for once
        this.pendingFarewell = null;        // ...or is waiting for the floor
        this.spokenBytes = 0;               // audio streamed for the current response
        this.spokenAt = 0;                  // when its first chunk went out
        this.pending = new Map();           // client requests waiting to be answered
        this.nextRequest = 1;
        this.opts = { apiKey, model, voice };
        this.trace = openTrace(sessionId, { form: form.name, notes, mode });
    }

  start() {
      const { apiKey, model } = this.opts;
      this.realTimeWs = new WebSocket(`${REALTIME_URL}?model=${encodeURIComponent(model)}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
      });
      this.realTimeWs.on('open', () => this.#configure()); // NOTE: This creates the agent
      this.realTimeWs.on('message', (raw) => this.handleEvent(JSON.parse(raw)));
      this.realTimeWs.on('error', (err) => this.emit('error', err));
      this.realTimeWs.on('close', () => { this.trace.close(); this.emit('close'); });
      return this;
  }

  /**
   * Raw PCM16 mono 24kHz from whatever is holding the microphone.
   *
   * The conversation is half duplex: while the agent has the floor nothing is
   * listened to. A client should stop sending too — it knows when its speaker
   * has actually finished playing, which is later than the model finishing
   * generating — but dropping here means a client that does not gate can still
   * never talk over itself.
   */
   sendAudio(chunk) {
       if (this.speaking || this.busy) return;
       this.#send({ type: 'input_audio_buffer.append', audio: Buffer.from(chunk).toString('base64') });
   }

  /** Typed input — same conversation, no microphone. Makes the agent testable. */
  sendText(text) {
      this.#send({
          type: 'conversation.item.create',
          item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
      });
      this.trace.write({ dir: 'in', type: 'user.text', text });
      this.#requestResponse();
  }

  /**
   * A human overrules the agent — someone read the screen, saw a wrong value
   * and fixed it by hand. Writes straight to the form, then tells the model so
   * it stops believing the old value. Deliberately does NOT make the agent
   * speak: correcting a typo should not interrupt the conversation.
   */
  correct(field, value, registration) {
    const reg = this.#resolveRegistration(registration);
    if (!reg) return { ok: false, error: `unknown registration ${registration ?? '(missing)'}` };

    const outcome = reg.state.correct(field, value);
    if (!outcome.ok) return outcome;

    const cleared = reg.state.data[field] === undefined;
    const who = this.#labelOf(reg) || reg.id;
    this.trace.write({ dir: 'human', type: 'correct', registration: reg.id, field, value });

    // A correction is a point-in-time event, so it goes in the history as a
    // system item. The resulting *state* is carried by the board instead.
    this.#send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'system',
        content: [{
          type: 'input_text',
          text: cleared
            ? `A staff member cleared "${field}" for ${who} (${reg.id}). Treat it as missing again. Do not mention this correction.`
            : `A staff member corrected "${field}" for ${who} (${reg.id}) to ${JSON.stringify(value)}. This is now the truth; do not save anything different for it and do not mention this correction.`,
        }],
      },
    });

    this.#publish(reg);
    return { ok: true };
  }

  /**
   * Ask whoever holds the client for something only they can produce — a
   * photograph, a signature, a scanned badge. The agent has no idea what it is
   * asking for or what comes back: `kind` is a word the client understands and
   * the answer is an opaque value it hands over. Nothing here knows what a
   * photo is, and nothing here should.
   *
   * There is no deadline. A kiosk that has not taken the photo yet is not a
   * failure, it is a person still walking up to the camera, and hanging up on
   * them would be the wrong answer to that. The wait ends when the client says
   * it ends.
   *
   * Nobody listening means nobody can answer — text mode, the CLI, a test. The
   * client's absence must never hang the agent, the same way the detector's
   * absence never takes the session down, so the request resolves empty.
   */
  ask(kind, payload = {}) {
    if (!this.listenerCount('request')) return Promise.resolve(null);
    const id = `q${this.nextRequest++}`;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.emit('request', { id, kind, ...payload });
    });
  }

  /** The client answered. An id nobody is waiting on is ignored. */
  answer(id, value) {
    const resolve = this.pending.get(id);
    if (!resolve) return false;
    this.pending.delete(id);
    resolve(value);
    return true;
  }

  /**
   * The room changed. This is the ONLY thing that creates or retires a
   * registration — the model never decides who exists.
   *
   * One snapshot produces one message and one response, so a group that walks
   * in together is greeted once rather than once per person. An identical
   * snapshot produces nothing, so a camera may fire continuously in silence.
   */
   roomUpdate({ arrived = [], departed = [], unidentifiedLeft = 0 } = {}) {
       // Mid-goodbye this session is spoken for. Somebody walking in now belongs
       // to the next one, which the server opens as soon as this socket closes.
       if (this.ending) return;
       
       if (!this.ready) {
           this.pendingRoom.push({ arrived, departed, unidentifiedLeft });
           
           return;
       }

       const lines = [];
       for (const person of arrived) {
           const open = [...this.registrations.values()].filter((r) => r.status === 'open');
           // BUG: How can open.length be greater than maxOpen???
           if (open.length >= this.maxOpen) break;
           
           const reg = this.#open(person);
           if (!this.focused) this.focused = reg.id; // Focus if there is no form focused
           this.#publish(reg);

           let line = `- ${reg.id}: ${this.#labelOf(reg) || 'not identified by the camera'}`;
           line = line + (person.notes ? ` (${person.notes})` : '');
           lines.push(line);
       }

       if (arrived.length) {
           const first = !this.greeted;
           this.greeted = true;
           lines.unshift(first
               ? `${arrived.length > 1 ? 'People have' : 'Someone has'} walked up to reception:`
               : `${arrived.length > 1 ? 'More people have' : 'Someone else has'} arrived:`);
           lines.push(arrived.length > 1
               ? 'Greet them together in ONE short sentence, then get on with it.'
               : 'Greet them briefly, then get on with it.');
       }

       for (const reg of departed) {
           lines.push(`${this.#labelOf(reg) || reg.id} has left. Registration ${reg.id} is unfinished — `
               + 'ask whether to carry on with it, and call close_registration if not.');
       }

       if (unidentifiedLeft) {
           lines.push(`${unidentifiedLeft} unidentified visitor(s) left and the camera cannot say which. `
               + 'Ask who is still here before closing anything.');
       }

       if (!lines.length) return;                 // same people as before: stay quiet
       this.#interject(lines.join('\n'));
   }

  close() {
    clearTimeout(this.boardTimer);
    clearTimeout(this.endTimer);
    this.realTimeWs?.close?.();
  }

  // ---------------------------------------------------------------- internals

  #send(event) { if (this.realTimeWs?.readyState === WebSocket.OPEN) this.realTimeWs.send(JSON.stringify(event)); }

  /**
   * Everything that happens, to the trace file and to anyone watching live.
   * Base64 audio is reduced to a size so the stream stays readable.
   */
   #traceEvent(entry) {
       this.trace.write(entry);

       value = typeof entry.delta === 'string' && entry.delta.length > 80
           ? { ...entry, delta: `<${entry.delta.length} b64 chars>` }
           : entry
       this.emit("debug", value);
   }

  /**
   * The only place a response is ever requested.
   *
   * `speaking` alone was not enough: it flips on response.created, so between
   * sending response.create and hearing back there was a window where a second
   * request slipped through and the server rejected it with "Conversation
   * already has an active response in progress".
   */
  #requestResponse(overrides = null) {
    if (this.responsePending) { this.queued = true; return; }
    this.responsePending = true;
    this.queued = false;
    this.#send(overrides ? { type: 'response.create', response: overrides } : { type: 'response.create' });
  }

  /**
   * @typedef {Object} Registration
   * @property {FormState} state - State of the form for the registration.
   */
  

  /** Create a registration. Only ever called from roomUpdate. */
  #open({ label = '', prefill = {}, origin = 'unknown', personKey = null } = {}) {
      const id = `r${this.nextId++}`; // Creates an ID like r1, r2, rn...
      
      /** @type {Registration} */
      const reg = {
          id,
          label,
          origin,
          personKey,
          state: new FormState(this.form.schema, { prefill, label }),
          status: 'open',
          result: null,
          beatDone: false,
          verified: new Map(),              // field -> the exact value that passed
          attachments: new Map(),           // field -> the bytes its token stands for
      };
      this.registrations.set(id, reg);
      return reg;
  }

  /**
   * Which registration a tool call meant. A missing id resolves to the only
   * open one — a model that forgets the argument in a one-visitor conversation
   * should not produce an error the visitor can hear.
   */
   #resolveRegistration(id) {
       if (id) return this.registrations.get(id) || null;
       
       // NOE: This can backfire
       const focused = this.registrations.get(this.focused);
       if (focused?.status === 'open') return focused;
       
       const open = [...this.registrations.values()].filter((r) => r.status === 'open');
       return open.length === 1 ? open[0] : null; // NOTE: What is the purpose for this validation?
   }

  /** The name to show and to call the person by. */
  #labelOf(reg) {
      return reg.label || reg.state.data[this.form.labelFrom] || '';
  }

  /**
   * @param {Registration} reg - Registration to be published.
   */
  #publish(reg) {
      // A correction that empties a required field earns a fresh confirmation.
      // NOTE: How a registration can be "completed" if it was just created?
      if (!reg.state.complete) reg.beatDone = false;
      // NOTE: What does emiting this event do?
      this.emit('state', {
          registration: reg.id,
          label: this.#labelOf(reg), // NOTE: Why is this not a Registration method?
          ...reg.state.snapshot(),
      });
      this.#scheduleBoard();
  }

  /**
   * A fact from the room. Acknowledging an arrival a sentence late feels wrong,
   * so if the agent is mid-sentence it gets cut off — and then picks the thread
   * back up. This is NOT barge-in: a visitor still cannot interrupt, only the
   * room can, and only for one sentence.
   */
  #interject(text) {
    this.#traceEvent({ dir: 'room', text });

    const interrupting = this.speaking || this.responsePending;
    if (interrupting) this.#cutOff();

    this.#send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'system',
        content: [{
          type: 'input_text',
          text: interrupting
            ? `${text}\n\nYou were cut off mid-sentence. Acknowledge this in ONE short sentence, `
              + 'then pick up exactly where you left off.'
            : text,
        }],
      },
    });

    // tool_choice 'none' makes this turn speech: it cannot reach for a tool and
    // silently skip the acknowledgement.
    this.#requestResponse(interrupting ? { tool_choice: 'none' } : null);
  }

  /**
   * Stop the agent talking, and tell the server how much the visitor actually
   * HEARD. Without the truncate the model believes it finished the sentence,
   * so on resuming it never repeats the half nobody heard.
   */
  #cutOff() {
    const a = this.audio;
    if (a?.itemId && a.firstAt) {
      const generatedMs = (a.bytes / (24000 * 2)) * 1000;   // pcm16 mono @24k
      const heardMs = Math.max(0, Math.min(Date.now() - a.firstAt, generatedMs));
      this.#send({
        type: 'conversation.item.truncate',
        item_id: a.itemId,
        content_index: 0,
        audio_end_ms: Math.round(heardMs),
      });
      // Deltas already in flight keep arriving after a truncate; drop them or
      // the agent talks over its own acknowledgement.
      this.truncatedItem = a.itemId;
    }
    this.#send({ type: 'response.cancel' });
    this.speaking = false;
    this.responsePending = false;
    this.queued = false;
    this.audio = null;
    this.emit('flush');                 // client empties its playback queue
    this.emit('speaking', false);
  }

  #entries() {
    return [...this.registrations.values()].map((r) => ({
      id: r.id,
      label: this.#labelOf(r),
      state: r.state,
      status: r.status,
      result: r.result,
      focused: r.id === this.focused,
    }));
  }

  /**
   * A turn that MUST be speech.
   *
   * `tool_choice: 'none'` makes tool calls impossible for this one response, so
   * the model cannot quietly skip what it was asked to say. Per-response
   * instructions REPLACE the session's rather than merging, so the persona has
   * to travel with them or the agent drops character for the turn.
   */
  #beat(directive) {
    return {
      tool_choice: 'none',
      instructions: [this.form.persona.trim(), '', directive].join('\n'),
    };
  }

  /** A form just filled up and the visitor has not confirmed it yet. */
  #completionBeat(reg) {
    if (!this.form.onComplete) return null;
    return this.#beat(
      `${nextAction(this.form, { label: this.#labelOf(reg), state: reg.state })}\n\n`
      + `Datos registrados: ${JSON.stringify(reg.state.snapshot().data)}`);
  }

  /**
   * Somebody was just finished with and other people are still waiting. Without
   * this the agent says goodbye and stops, and a visitor has to prompt it to
   * carry on.
   */
  #handoverBeat(finished) {
    const next = this.registrations.get(this.focused);
    if (!next || next.status !== 'open') return null;      // nobody left to serve

    const farewell = `You have just finished with ${this.#labelOf(finished) || finished.id}. `
      + 'Say goodbye to them in ONE short sentence, then turn to '
      + `${this.#labelOf(next) || 'the visitor still waiting'}, who has not been registered yet.`;

    // If that person's form is already full, what they need is their
    // confirmation, not another question.
    const then = next.state.complete
      ? nextAction(this.form, { label: this.#labelOf(next), state: next.state })
      : `Ask them for the first thing you still need: ${next.state.missing().join(', ')}.`;

    if (next.state.complete) next.beatDone = true;         // do not read back twice
    return this.#beat(`${farewell}\n\n${then}`);
  }

  /**
   * The mirror image of #handoverBeat: that one fires when somebody is still
   * waiting, this one when nobody is.
   *
   * Forced for the same reason the read-back is. The board does say everyone
   * has been dealt with, but a board is a description — the model can answer it
   * by reaching for a tool and the last visitor walks away in silence. With
   * tool_choice 'none' the only thing this turn can be is the goodbye.
   */
  #farewellBeat(finished) {
    const who = this.#labelOf(finished);
    return this.#beat(
      `You have just finished with ${who || 'the visitor'}, and there is nobody else waiting. `
      + `Say goodbye${who ? ` to ${who}` : ''} warmly in ONE short sentence. `
      + 'Ask nothing, offer nothing and add nothing else — this is the last thing you say.');
  }

  /**
   * Nobody is left to register. A receptionist with an empty lobby does not
   * stand at the desk waiting to be spoken to, and neither does this: the
   * session closes and the next arrival opens a fresh one.
   *
   * A submitted registration earns the goodbye. A closed one does not — it was
   * abandoned, usually because the person walked off, and there is nobody
   * standing there to hear it.
   */
  #endSession(finished) {
    this.ending = true;
    if (finished.status !== 'submitted') return this.#finish();
    this.pendingFarewell = finished;
    this.#sayFarewell();
  }

  /**
   * Ask for the goodbye, once the floor is free.
   *
   * It usually is. But a slow submit tool covers its own wait with "un
   * momento", and that response is still in flight when the form comes back
   * submitted — #requestResponse would quietly queue the farewell behind it and
   * the session would close on the cover sentence, saying goodbye to nobody.
   * So it waits instead, and the turn that frees the floor plays it.
   */
  #sayFarewell() {
    if (!this.pendingFarewell || this.responsePending) return false;
    const finished = this.pendingFarewell;
    this.pendingFarewell = null;
    this.farewellDone = true;
    this.#requestResponse(this.#farewellBeat(finished));
    return true;
  }

  /**
   * Hang up — but not before the goodbye has actually been heard.
   *
   * The server generates audio faster than it plays, so `response.done` means
   * "finished generating", not "finished speaking"; closing on it clips the
   * last words off. There is no server event for playback either — the one that
   * tracks it, output_audio_buffer.stopped, exists only on WebRTC and SIP, and
   * this is a raw WebSocket. So we wait out the exact duration of what we
   * streamed, which we already count for the same reason #cutOff does.
   *
   * In text mode nothing was spoken, so this is immediate.
   */
  #finish() {
    if (this.ended) return;
    this.ended = true;

    const generatedMs = (this.spokenBytes / (24000 * 2)) * 1000;   // pcm16 mono @24k
    const remaining = this.spokenAt ? (this.spokenAt + generatedMs) - Date.now() : 0;

    this.endTimer = setTimeout(() => {
      this.trace.write({ dir: 'agent', type: 'session.ended' });
      this.emit('ended', { session: this.sessionId });
      this.close();
    }, Math.max(0, remaining));
  }

  /**
   * Run a tool the way it was decorated.
   *
   * Undecorated and `blocking` are both awaited, so callers get a real result
   * and none of their bookkeeping changes. The difference is that a slow
   * blocking tool says so first, and holds the floor while it works.
   */
  async #call(fn, ...args) {
    const meta = modeOf(fn);
    if (!meta) return fn?.(...args);                   // unchanged path

    const work = withTimeout(Promise.resolve().then(() => fn(...args)), meta.timeoutMs);

    if (!meta.hold) {
      // Answer the model straight away so the conversation never stalls, and
      // report back later through the same interjection an arrival uses.
      work.then(
        (r) => meta.announce && this.#interject(meta.done?.(r)
          || `It finished: ${JSON.stringify(r)}. Tell them briefly.`),
        (e) => meta.announce && this.#interject(meta.fail?.(e)
          || 'It failed. Apologise in ONE short sentence and say they should ask at the desk.'),
      );
      return { ok: true, status: 'in_progress', note: 'Started. Do NOT say it is finished yet.' };
    }

    this.busy = true;
    this.emit('busy', true);
    try {
      // Only cover the wait if there is a wait worth covering — a 50ms tool
      // does not need "un momento".
      const finishedFast = await Promise.race([
        work.then(() => true, () => true),
        new Promise((r) => setTimeout(() => r(false), meta.coverAfterMs)),
      ]);
      if (!finishedFast) {
        // A `say` function gets the tool's own arguments, so the cover sentence
        // can name what is being looked up rather than stalling generically.
        const say = typeof meta.say === 'function' ? meta.say(...args) : meta.say;
        this.#requestResponse(this.#beat(say
          || 'Tell them you are dealing with it and to wait a moment. Do NOT say it is done.'));
      }
      return await work;
    } finally {
      this.busy = false;
      this.emit('busy', false);
    }
  }

  /**
   * Some values are only true if something outside this building agrees — a
   * name that has to exist in a directory. A field says so with `verify` in the
   * schema, and it runs here, on the way through save_fields.
   *
   * That is the whole point of putting it here: save_fields is the only road a
   * spoken value travels, so the check cannot be skipped. A staff correction
   * and a camera prefill both come from outside the conversation and are not
   * second-guessed.
   *
   * A refusal is not an error. The field is cleared, the reason joins the same
   * `rejected` array a schema violation uses, and the board asks for it again —
   * no new machinery to steer the conversation with. Anything that throws or
   * times out is a refusal too, so a form that forgets a try/catch can never
   * break a save.
   */
   async #verify(reg, changed, problems) {
       for (const field of [...changed]) {
           const check = this.form.schema.properties?.[field]?.verify;
           if (!check) continue;

           const value = reg.state.data[field];
           if (reg.verified.get(field) === value) continue;   // this exact answer already passed

           const outcome = await this.#call(check, value, { data: reg.state.data }).catch(() => null);
           if (outcome?.ok) { reg.verified.set(field, value); continue; }

           reg.state.correct(field, '');                      // clears the value and its evidence
           changed.splice(changed.indexOf(field), 1);         // never report it as saved
           problems.push(`${field}: ${outcome?.error || 'no pude confirmarlo'}`);
       }
   }

  /**
   * Take `attach` out of a tool result and put a token in the form instead.
   *
   * A photograph is sixty kilobytes of base64, and `data` is read by four
   * different things: the board stringifies every value into the session
   * instructions and pushes them on each change, tool results are written to
   * the trace and mirrored to the debug stream, and the result itself goes
   * back to the model. Bytes in `data` are bytes in all four.
   *
   * So what lands in the form is the word `captured`. The value it stands for
   * lives beside it and is put back in exactly one place, submit_form, which
   * is the only thing that ever actually needed it.
   *
   * The token is written straight in rather than through `state.correct()`:
   * this is not a human overruling the agent, and the `client` source is what
   * tells a screen this field is not one anybody typed.
   */
  #attach(reg, out) {
    if (!out?.attach) return out;

    for (const [field, value] of Object.entries(out.attach)) {
      reg.attachments.set(field, value);
      reg.state.data[field] = 'captured';
      reg.state.evidence[field] = { source: 'client', heard: null };
    }
    delete out.attach;              // before the caller traces it or sends it on

    this.#publish(reg);
    return out;
  }

  /** When the person being addressed is finished with, move to whoever is next. */
  #advanceFocus(from) {
    if (this.focused !== from.id) return;
    const next = [...this.registrations.values()].find((r) => r.status === 'open');
    if (!next) return;
    this.focused = next.id;
    this.emit('focus', { registration: next.id, label: this.#labelOf(next) });
  }

  #instructions() {
      return buildInstructions(
          this.form,
          { notes: this.notes, entries: this.#entries() }
      );
  }

  /**
   * Rewrite the status block the model reads. Pushing it costs a round trip, so
   * out-of-band changes (a staff correction) are debounced and never land in
   * the middle of a response.
   */
   #scheduleBoard() {
       // NOTE: Wouldn't be better to implement another mechanism to update the board?
       //       Does setTimeout could introduce unwanted latency to the agent response?
       clearTimeout(this.boardTimer); // NOTE: WHAT IS A TIMER DOING HERE???
       // NOTE: ANOTHER TIMER?!
       this.boardTimer = setTimeout(() => {
           if (this.speaking) return this.#scheduleBoard(); // NOTE: Why do we need to wait for the agent to stop speaking?
           this.#flushBoard();
       }, 250);
   }

  /**
   * Push it right now. Used after tool calls, where the board MUST be current
   * before the model gets the floor back — that is the exact turn where a form
   * has just become complete.
   */
   #flushBoard() {
       clearTimeout(this.boardTimer); // NOTE: Whats the purpose of clearing the timeout here?
       this.boardTimer = null;
       if (!this.ready) return;

       const flushEvent = {
           type: 'session.update',
           session: {
               type: 'realtime',
               instructions: this.#instructions()
           }
       };
       this.#send(flushEvent);

       console.log("Board flushed to Real Time API!!!");
       console.log("Sending new instructions:\r\n", flushEvent);
   }

   #configure() {
       this.#send({
           type: 'session.update',
           session: {
               type: 'realtime',
               output_modalities: [this.mode === 'text' ? 'text' : 'audio'],
               audio: {
                   input: {
                       format: { type: 'audio/pcm', rate: 24000 },
                       // Let the model judge when a thought is finished instead of a
                       // silence timer. Handles "me llamo... Víctor Delgado" without a
                       // number to tune.
                       turn_detection: this.mode === 'text' ? null : { type: 'semantic_vad' },
                       transcription: { model: 'gpt-4o-transcribe', ...(this.form.language ? { language: this.form.language } : {}) },
                   },
                   output: { format: { type: 'audio/pcm', rate: 24000 }, voice: this.opts.voice },
               },
               instructions: this.#instructions(),
               tools: buildTools(this.form),
               tool_choice: 'auto',
           },
       });
   }

  /**
   * Handle one server event. Public so tests — and a trace replay — can drive
   * the agent without a socket.
   */
   handleEvent(e) { // TODO: Check if there is a type annotation for event
       this.#traceEvent({ dir: 'openai', ...e });

       switch (e.type) {
           
           case 'session.updated':
               if (!this.ready) {
                   this.ready = true;
                   this.emit('open');
                   // Anything the detector reported during the handshake.
                   const queued = this.pendingRoom;
                   this.pendingRoom = [];
                   for (const plan of queued) this.roomUpdate(plan);
               }
               return;

           case 'error':
               return this.emit('error', new Error(e.error?.message || 'realtime error'));

           case 'conversation.item.input_audio_transcription.completed':
               return this.emit('transcript', { role: 'user', text: e.transcript });

           case 'response.created':
               this.speaking = true;
               // Counted per response, not per item: the goodbye is measured to know
               // when it has finished playing.
               this.spokenBytes = 0;
               this.spokenAt = 0;
               this.emit('speaking', true);
               return;

           case 'response.output_item.added':
               this.audio = { itemId: e.item?.id, firstAt: 0, bytes: 0 };
               return;

           case 'response.output_audio.delta': {
               if (e.item_id && e.item_id === this.truncatedItem) return;   // stale, cut already
               const buf = Buffer.from(e.delta, 'base64');
               if (this.audio) {
                   if (!this.audio.firstAt) this.audio.firstAt = Date.now();
                   this.audio.bytes += buf.length;
               }
               if (!this.spokenAt) this.spokenAt = Date.now();
               this.spokenBytes += buf.length;
               return this.emit('audio', buf);
           }

           case 'response.done': // NOTE: This is where tools are called by the model
               this.speaking = false;
               this.responsePending = false;
               this.emit('speaking', false);
               
               return this.#onResponseDone(e.response); // NOTE: It's returning a promise!
       }
   }

   async #onResponseDone(response) {
       for (const item of response?.output || []) {
           if (item.type === 'message') {
               const text = (item.content || [])
                   .map((c) => c.text || c.transcript || '')
                   .join(' ')
                   .trim();
               if (text) this.emit('transcript', { role: 'agent', text });
           }
       }

       // The session is on its way out: either that turn was the goodbye, or it
       // was something holding the floor that the goodbye has been waiting for.
       if (this.ending) return void (this.#sayFarewell() || this.#finish());

       const calls = (response?.output || []).filter((i) => i.type === 'function_call');
       if (!calls.length) {
           // A room event that arrived mid-sentence has been waiting for the floor.
           if (this.pendingNudge) { this.pendingNudge = false; return this.#requestResponse(); }
           if (this.queued) { this.queued = false; return this.#requestResponse(); }
           if (this.busy) return;                           // a blocking tool holds the floor
           return this.emit('idle');                        // agent finished its turn
       }

       const before = new Map([...this.registrations].map(
           ([id, r]) => [id, { complete: r.state.complete, status: r.status }]));

       for (const call of calls) {
           let args = {};
           // NOTE: We might want to implement a fallback for corrupted args
           try {
               args = JSON.parse(call.arguments || '{}');
           } catch { /* model sent junk; treated as empty */ }
           
           const result = await this.#runTool(call.name, args);
           this.#traceEvent({ dir: 'tool', name: call.name, args, result });
           this.#send({
               type: 'conversation.item.create',
               item: { type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) },
           });
       }

       // The board must be current BEFORE the model speaks again: this is the
       // turn where a form may have just become complete.
       this.#flushBoard();
       this.pendingNudge = false;

       // Somebody was finished with this turn and others are still waiting.
       // Checked first: it subsumes the completion case for the person handed to.
       const justFinished = [...this.registrations.values()].find(
           (r) => r.status !== 'open' && before.get(r.id)?.status === 'open',
       );
       if (justFinished) {
           const beat = this.#handoverBeat(justFinished);
           if (beat) return this.#requestResponse(beat);
           // No beat means nobody is waiting: that was the last person in the room.
           return this.#endSession(justFinished);
       }

       // Whichever registration just became complete gets its forced beat.
       const justCompleted = [...this.registrations.values()].find(
           (r) => r.status === 'open' && r.state.complete && !r.beatDone && !before.get(r.id)?.complete,
       );
       if (justCompleted) {
           const beat = this.#completionBeat(justCompleted);
           if (beat) {
               justCompleted.beatDone = true;
               return this.#requestResponse(beat);
           }
       }

       // The model is waiting on those results — give it the floor back.
       this.#requestResponse();
   }

   async #runTool(name, args) {
       // Tool results report what happened. What to do next lives in the board.
       if (name === 'open_registrations') {
           return {
               registrations: [...this.registrations.values()].map((r) => ({
                   id: r.id, label: this.#labelOf(r), status: r.status, missing: r.state.missing(),
               })),
           };
       }

       // Everything below is about one specific person.
       const reg = this.#resolveRegistration(args.registration);
       if (!reg) {
           return {
               ok: false,
               error: this.registrations.size
               ? `unknown registration ${args.registration ?? '(missing)'}`
               : 'nobody has arrived at reception yet',
               valid: [...this.registrations.values()]
                   .filter((r) => r.status === 'open')
                   .map((r) => ({ id: r.id, label: this.#labelOf(r) })),
           };
       }

       if (name === 'focus') {
           this.focused = reg.id;
           this.#scheduleBoard();
           this.emit('focus', { registration: reg.id, label: this.#labelOf(reg) });
           return { ok: true, registration: reg.id, label: this.#labelOf(reg), missing: reg.state.missing() };
       }

       if (name === 'save_fields') {
           // Saving onto someone other than the person being addressed is allowed,
           // and recorded. A human reading the table sees exactly that.
           const addressing = reg.id === this.focused
               ? null
               : (this.#labelOf(this.registrations.get(this.focused)) || this.focused);

           // A field the client owns is not the model's to write. Leaving it out
           // of the tool schema asks it not to; this is what stops it. A value
           // invented here would satisfy `missing`, and the tool that actually
           // captures the thing would then never be called at all.
           const fields = { ...(args.fields || {}) };
           const refused = Object.keys(fields)
               .filter((f) => this.form.schema.properties?.[f]?.client);
           for (const f of refused) delete fields[f];

           const { problems, changed } = reg.state.save(fields, args.quotes || {}, { addressing });
           for (const f of refused) problems.push(`${f}: not yours to fill; the kiosk captures it`);
           await this.#verify(reg, changed, problems);
           
           this.#publish(reg);
           
           return {
               registration: reg.id,
               label: this.#labelOf(reg),
               saved: changed,
               missing: reg.state.missing(),
               ...(problems.length ? { rejected: problems } : {}),
           };
       }

       if (name === 'submit_form') {
           const missing = reg.state.missing();
           if (missing.length) return { ok: false, registration: reg.id, missing };
           try {
               const snapshot = reg.state.snapshot();
               // Tokens go back to being what they stand for. This is the only
               // place the real bytes leave `attachments` — the snapshot the
               // screen and the trace get still carries the token.
               const payload = { ...snapshot.data, ...Object.fromEntries(reg.attachments) };
               const result = (await this.#call(this.form.submit, payload)) || {};
               reg.status = 'submitted';
               reg.result = result;
               this.#advanceFocus(reg);
               this.emit('done', {
                   registration: reg.id, label: this.#labelOf(reg), ...snapshot, result,
               });
               return { ok: true, registration: reg.id, ...result };
           } catch (err) {
               return { ok: false, error: 'The registration system did not respond.' };
           }
       }

       if (name === 'close_registration') {
           reg.status = 'closed';
           this.#advanceFocus(reg);
           this.trace.write({ dir: 'tool', type: 'closed', registration: reg.id, reason: args.reason });
           return { ok: true, registration: reg.id };
       }

       const customTool = (this.form.tools || []).find((t) => t.definition.name === name);
       if (customTool) {
           // `ask` is how a form reaches the client. What it asks for, and what
           // it does with the answer, is the form's business; the engine only
           // carries it — and diverts whatever comes back as `attach`.
           try {
               return this.#attach(reg, await this.#call(customTool.run, args, {
                   data: reg.state.data,
                   ask: (kind, payload) => this.ask(kind, payload),
               }));
           }
           catch (err) {
               return { ok: false, error: String(err.message || err) };
           }
       }

       return { ok: false, error: `unknown tool ${name}` };
   }
}
