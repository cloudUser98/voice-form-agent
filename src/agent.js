import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { buildInstructions, buildTools, availableTools, nextAction } from './prompt.js';
import { FormState } from './form-state.js';
import { modeOf, withTimeout } from './tools.js';
import { openTrace } from './trace.js';
import { resolveLanguage, languageBlock, transcriptionConfig, DEFAULT_LOCALE } from './language.js';
import { userSchemaProblems, arrival, explanation, sameValue } from './user.js';
import { checkField, isEmpty } from './validate.js';

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
        capabilities = null,                // what the client can do; null = everything
        apiKey = process.env.OPENAI_API_KEY,
        model = process.env.REALTIME_MODEL || 'gpt-realtime-2.1',
        voice = form?.voice || 'marin',
        // BCP-47 tag or { locale, accent }. The form's wins over the env; the
        // engine's own default is American English.
        language = form?.language || process.env.AGENT_LANGUAGE || DEFAULT_LOCALE,
        transcriptionModel = process.env.TRANSCRIPTION_MODEL || 'gpt-4o-transcribe',
        sessionId = `s_${Date.now().toString(36)}`,
    } = {}) {
        super();
        if (!form) throw new Error('FormAgent needs a form definition');
        if (!apiKey) throw new Error('FormAgent needs an OpenAI API key');
        const userProblems = userSchemaProblems(form);
        if (userProblems.length) throw new Error(`${form.name || 'form'}: ${userProblems.join('; ')}`);
    
        this.form = form;
        this.language = resolveLanguage(language);
        this.mode = mode;
        this.notes = notes;
        this.maxOpen = maxOpen;
        // What the thing at the other end can actually do. A tool that needs
        // something this client has not got is never shown to the model, so the
        // agent cannot offer it. null means nobody said, which means everything.
        this.capabilities = capabilities;
    
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
        this.waiting = [];                  // what wanted the floor while it was taken
        this.flight = [];                   // responses under way, oldest first — see #requestResponse
        this.busyDepth = 0;                // how many blocking tools hold the floor
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
        this.opts = { apiKey, model, voice, transcriptionModel };
        this.trace = openTrace(sessionId, { form: form.name, notes, mode });
    }

  /**
   * Is a blocking tool holding the floor?
   *
   * Counted rather than flagged, because blocking tools nest: a tool that comes
   * back with `fields` runs the `verify` of every field it filled, and one of
   * those is blocking too. A boolean meant the inner check's `finally` reopened
   * the microphone while the outer tool was still working.
   */
  get busy() { return this.busyDepth > 0; }

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
    // Staff overrule; a change the visitor was about to be asked about is moot.
    reg.proposals.delete(field);

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
   * Somebody is here, and this is their user record — or null for a new user.
   *
   * A record that does not fit the form's user schema is refused outright and
   * nobody is registered: the integrator's data is wrong, and prefilling part
   * of it would hide that. The same person twice is refused too, so a
   * connector that repeats itself cannot open a second form for them.
   */
  arrive(record = null) {
    const r = arrival(this.form, record);
    if (!r.ok) {
      this.trace.write({ dir: 'in', type: 'user.refused', key: r.key ?? null, problems: r.problems });
      return { ok: false, problems: r.problems };
    }
    const key = r.person.personKey;
    if (key !== null && [...this.registrations.values()].some((g) => g.personKey === key && g.status === 'open')) {
      return { ok: false, problems: [`${key}: already has an open registration`] };
    }
    this.roomUpdate({ arrived: [r.person] });
    return { ok: true };
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
       const created = [];
       let opening = false;               // this greeting also asks a skippable question
       for (const person of arrived) {
           const open = [...this.registrations.values()].filter((r) => r.status === 'open');
           // BUG: How can open.length be greater than maxOpen???
           if (open.length >= this.maxOpen) break;
           
           const reg = this.#open(person);
           created.push(reg);
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
           // An opening step rides along with the greeting rather than earning a
           // turn of its own, because two forced sentences back to back is not
           // how anybody says hello. A form with no opening tool, or a client
           // that cannot serve it, gets the greetings it always got.
           const ask = this.#pendingOpening(created);
           lines.push(ask
               ? (arrived.length > 1
                   ? 'Greet them together in ONE short sentence.'
                   : 'Greet them briefly.')
               : (arrived.length > 1
                   ? 'Greet them together in ONE short sentence, then get on with it.'
                   : 'Greet them briefly, then get on with it.'));
           if (ask) lines.push(`${ask}\nDo not call any tool yet — wait for their answer.`);
           // 
           opening = !!ask;
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
       // With an opening step this is a turn that must ASK before it acts:
       // otherwise the model answers the greeting by reaching straight for the
       // thing it was supposed to ask about. With no opening step `speechOnly`
       // is false and the arrival turn is free to greet and act at once.
       this.#interject(lines.join('\n'), { speechOnly: opening });
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

       const value = typeof entry.delta === 'string' && entry.delta.length > 80
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
   *
   * While a response is in flight a request waits its turn — and it waits with
   * what it asked for. It used to be a single `queued` flag, which remembered
   * that somebody wanted the floor and forgot what they wanted to say: a
   * proposal beat asked for while a cover sentence was still playing went out
   * as a plain response, the explanation was never given, and because the
   * proposal was already marked asked it never would be.
   *
   * So a beat is kept, in order, and never merged or overwritten — two beats
   * are two different things that have to be said. A plain request only asks
   * that the model get the floor, which any response does, so it is dropped
   * once anything else is waiting or anything is sent.
   *
   * `tag` marks a request its caller may take back — a cover sentence, whose
   * tool can finish before it is ever heard. See #withdraw.
   *
   * Every response sent is recorded in `flight` until its response.done:
   *   id         the server's, once response.created says what it is
   *   cut        #cutOff abandoned it; its response.done does not free the floor
   *   tag        who asked for it
   *   audible    output for it has started reaching the client
   *   withdrawn  its caller took it back before anything was heard
   */
  #requestResponse(overrides = null, tag = null) {
    if (this.responsePending) {
      if (overrides) {
        this.waiting = this.waiting.filter((w) => w.overrides);
        this.waiting.push({ overrides, tag });
      } else if (!this.waiting.length) {
        this.waiting.push({ overrides: null, tag });
      }
      return;
    }
    this.responsePending = true;
    this.waiting = this.waiting.filter((w) => w.overrides);
    this.flight.push({ id: null, cut: false, tag, audible: false, withdrawn: false });
    this.#send(overrides ? { type: 'response.create', response: overrides } : { type: 'response.create' });
  }

  /** Give the floor to whatever has been waiting for it. False if nothing was. */
  #next() {
    const w = this.waiting.shift();
    if (!w) return false;
    this.#requestResponse(w.overrides, w.tag);
    return true;
  }

  /**
   * Take back a response nobody has heard yet.
   *
   * A cover sentence is asked for because a tool looked slow, and the realtime
   * model takes 0.5–1.5 s to start speaking. A tool that finishes inside that
   * window used to be followed by "un momento" anyway — "please wait" after the
   * wait was over, "bring your code to the reader" after it had been read. So
   * the tool withdraws its own cover when it finishes: still waiting, it never
   * goes out; sent but silent, it is cancelled. Once its audio has started it is
   * left alone, because cutting a sentence off mid-word is worse than a
   * sentence that is a moment late.
   *
   * Nothing of a withdrawn response reaches the client, and its items are
   * deleted from the conversation, so the model does not believe it said
   * something nobody heard. Whatever was waiting behind it still goes next.
   */
  #withdraw(tag) {
    this.waiting = this.waiting.filter((w) => w.tag !== tag);
    const r = this.flight.find((f) => f.tag === tag && !f.cut);
    if (!r || r.audible || r.withdrawn) return;
    r.withdrawn = true;
    this.trace.write({ dir: 'agent', type: 'cover.withdrawn', response: r.id });
    // Until response.created names it there is nothing to cancel; it is
    // cancelled the moment it does.
    if (r.id) this.#send(r.id === '?' ? { type: 'response.cancel' } : { type: 'response.cancel', response_id: r.id });
  }

  /** The response a streamed delta belongs to; without an id, the newest. */
  #flightOf(responseId) {
    return (responseId && this.flight.find((f) => f.id === responseId)) || this.flight.at(-1) || null;
  }

  /**
   * How much of what has already been generated the visitor has still to hear.
   * Generation outruns playback, so the sentence that called a tool is often
   * still coming out of the speaker when the tool starts. Same arithmetic as
   * #finish; zero in text mode.
   */
  #stillPlayingMs() {
    if (!this.spokenAt) return 0;
    return Math.max(0, this.spokenAt + (this.spokenBytes / (24000 * 2)) * 1000 - Date.now());
  }

  /**
   * @typedef {Object} Registration
   * @property {FormState} state - State of the form for the registration.
   */
  

  /** Create a registration. Only ever called from roomUpdate. */
  #open({ label = '', prefill = {}, protect = {}, origin = 'unknown', personKey = null } = {}) {
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
          // Prefilled values the conversation may not simply overwrite, and the
          // changes to them that are waiting for a yes. See src/user.js.
          protect,                          // field -> { readOnly, confirmOnly, beforeUpdate, value }
          proposals: new Map(),             // field -> { from, to, quote, asked }
          beatHeld: false,                  // completed while a change was pending
          attachments: new Map(),           // field -> the bytes its token stands for
          // A question that is asked once and may be turned down. Seeded only
          // with the steps THIS client can actually serve, so a kiosk with no
          // reader has nothing to skip and codes are never mentioned at all.
          steps: new Map(this.#openingTools().map((t) => [t.definition.name, 'pending'])),
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

  /**
   * Tools that want asking before anything else.
   *
   * A tool carries `opening` when its question is only worth asking up front —
   * a code that fills half the form is worth a sentence before the first
   * question, and worth nothing after the last. Declining is a normal answer,
   * so the step is recorded either way and never asked twice.
   *
   * Asked once is not the same as available once, and getting that wrong is
   * what made this hurt the first time round. `scan_code` was an opening step
   * with a twenty-second deadline, so the question and the tool expired
   * together and anyone still going through their bag had lost both. The tool
   * now waits as long as it takes, `codigo` stays on the board as an empty
   * optional field after a skip, and nothing stops it being called later. What
   * `opening` buys is only the ORDER — the question comes first, where the
   * answer is worth four other questions — and never asking it twice unbidden.
   *
   * See CONTEXT.md, "A question asked first", for the whole shape.
   */
  #openingTools() {
    return availableTools(this.form, this.capabilities).filter((t) => t.opening);
  }

  /** What to ask these arrivals before anything else, if anything. */
  #pendingOpening(regs) {
    const waiting = new Set();
    for (const reg of regs) {
      for (const [step, status] of reg.steps || []) if (status === 'pending') waiting.add(step);
    }
    if (!waiting.size) return '';
    return this.#openingTools()
      .filter((t) => waiting.has(t.definition.name))
      .map((t) => t.opening)
      .join(' ');
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
  #interject(text, { speechOnly = false } = {}) {
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
    this.#requestResponse(interrupting || speechOnly ? { tool_choice: 'none' } : null);
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
    // Whatever was under way has been abandoned. Its response.done still
    // arrives, after the interjection has already asked for the floor, and must
    // not be read as the floor coming free — see #landed.
    for (const r of this.flight) r.cut = true;
    // The interjection answers a plain request. A beat still has to be said,
    // and is — after the interjection's own turn.
    this.waiting = this.waiting.filter((w) => w.overrides);
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
      steps: r.steps,
      // Only what the question needs: the value now and the one they asked for.
      proposals: [...r.proposals].map(([field, p]) => ({ field, from: p.from, to: p.to })),
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
      instructions: [this.form.persona.trim(), '', languageBlock(this.language), '', directive].join('\n'),
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
   * Somebody asked to change a value from their profile. Nothing has been
   * written; this is the turn that tells them what the change means and asks.
   * `beforeUpdate` is the integrator's reason, put in the agent's own words and
   * language — it is guidance, not a script to read out.
   */
  #proposalBeat(reg) {
    const who = this.#labelOf(reg) || 'The visitor';
    const lines = [...reg.proposals]
      .filter(([, p]) => !p.asked)
      .map(([field, p]) => {
        p.asked = true;
        return `- ${field}: from ${JSON.stringify(p.from)} to ${JSON.stringify(p.to)}. `
          + `What changing it means: ${explanation(reg.protect[field])}`;
      });
    return this.#beat(
      `${who} (${reg.id}) asked to change something that comes from their registered profile. `
      + `NOTHING has been changed yet.\n${lines.join('\n')}\n\n`
      + 'In ONE or TWO short sentences, explain in your own words what making this change means, '
      + 'then ask them to confirm that they want it. Do not say it is done.');
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
   * Hold the floor for the whole of `work`, not just the tool that started it.
   *
   * A blocking tool that comes back with `fields` is not finished when its own
   * function returns: every field it filled still has to be verified, and one of
   * those checks is a blocking tool in its own right. Without this the floor is
   * released in between, the microphone reopens for the gap, and the client sees
   * the agent go free and busy again for what the visitor experiences as one
   * wait. Depth is counted, so the inner checks simply nest.
   */
  async #holdFloor(work) {
    if (this.busyDepth++ === 0) this.emit('busy', true);
    try { return await work(); }
    finally { if (--this.busyDepth === 0) this.emit('busy', false); }
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

    // Only the outermost blocking tool announces the floor, so a client sees one
    // pair of events per wait however many checks that wait turns out to contain.
    if (this.busyDepth++ === 0) this.emit('busy', true);
    const cover = Symbol('cover');
    try {
      // Only cover the wait if there is a wait worth covering — a 50ms tool
      // does not need "un momento". And the wait is the SILENCE, not the tool:
      // the clock starts once the sentence that called the tool has finished
      // playing, the way LiveKit's with_filler counts from an idle session.
      // "Dame un momento para finalizar tu registro" already covers a one-second
      // submit; a second "espera un momento" after it is the wait said twice.
      let timer;
      const finishedFast = await Promise.race([
        work.then(() => true, () => true),
        new Promise((r) => { timer = setTimeout(() => r(false), meta.coverAfterMs + this.#stillPlayingMs()); }),
      ]);
      clearTimeout(timer);
      if (!finishedFast) {
        // A `say` function gets the tool's own arguments, so the cover sentence
        // can name what is being looked up rather than stalling generically.
        const say = typeof meta.say === 'function' ? meta.say(...args) : meta.say;
        this.#requestResponse(this.#beat(say
          || 'Tell them you are dealing with it and to wait a moment. Do NOT say it is done.'), cover);
      }
      return await work;
    } finally {
      this.#withdraw(cover);
      if (--this.busyDepth === 0) this.emit('busy', false);
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
   * A value from the user's own profile is not the conversation's to overwrite.
   *
   * Submitting this form may write back to the integrator's user database, so
   * "my name is Luis Miguel" to a kiosk that knows him as Luis would rename his
   * account. Asking the model to warn first is not enough — the prompt also
   * tells it to save the moment it hears something, and on some turns that
   * instruction wins. So the write itself is what is stopped: a protected field
   * is taken out of the patch here, on the only road a conversational value
   * travels, before anything is saved.
   *
   *   readOnly     refused, and the refusal carries `beforeUpdate` so the agent
   *                can say why.
   *   confirmOnly  becomes a proposal. Nothing is written until confirm_change
   *                comes back with a yes — see #proposalBeat for the asking.
   *
   * The same value again is not a change, whatever its capitals or spacing,
   * and going back to what the profile says is never one either.
   *
   * Mutates `fields`. Returns what was refused and what now awaits a yes.
   */
  #gate(reg, fields, quotes = {}) {
    const problems = [];
    const proposed = [];

    for (const field of Object.keys(fields)) {
      const rule = reg.protect[field];
      const next = fields[field];
      if (!rule || isEmpty(next)) continue;

      const current = reg.state.data[field];
      // Nothing changes. Dropped rather than saved, so a value the visitor
      // merely repeated keeps saying it came from their profile.
      if (sameValue(next, current)) { delete fields[field]; continue; }
      if (sameValue(next, rule.value)) continue;            // back to the profile's own value

      delete fields[field];
      if (rule.readOnly) { problems.push(`${field}: ${explanation(rule)}`); continue; }

      // Never ask somebody to confirm a value that would be refused anyway.
      const invalid = checkField(field, this.form.schema.properties[field], next);
      if (invalid.length) { problems.push(...invalid); continue; }

      const quote = typeof quotes[field] === 'string' && quotes[field].trim() ? quotes[field].trim() : null;
      reg.proposals.set(field, { from: current, to: next, quote, asked: false });
      proposed.push(field);
      this.trace.write({ dir: 'tool', type: 'change.proposed', registration: reg.id, field, from: current, to: next });
    }

    return { problems, proposed };
  }

  /**
   * The answer to a proposal. A yes writes the value exactly the way a spoken
   * value is written — schema, then `verify` — and records, for the people
   * reading the screen, what it replaced. A no leaves the profile's value alone.
   *
   * What it replaced goes in `evidence` and nowhere else. The board carries
   * only the value as it now stands: telling the model what a field used to be
   * is how it ends up using the old one.
   */
  async #settle(reg, field, accept, quote) {
    const proposal = reg.proposals.get(field);
    reg.proposals.delete(field);
    this.trace.write({ dir: 'tool', type: 'change.answered', registration: reg.id, field, accept });
    if (!accept) return { changed: [], problems: [] };

    const before = { value: reg.state.data[field], evidence: reg.state.evidence[field] };
    const { problems, changed } = reg.state.save(
      { [field]: proposal.to },
      proposal.quote ? { [field]: proposal.quote } : {},
    );
    await this.#verify(reg, changed, problems);

    if (changed.includes(field)) {
      reg.state.evidence[field] = {
        ...reg.state.evidence[field],
        previous: proposal.from,
        confirmed: true,
        ...(typeof quote === 'string' && quote.trim() ? { confirmedWith: quote.trim() } : {}),
      };
    } else {
      // The world refused the new value. That must not cost them the one on
      // their profile, which is what a plain `verify` refusal would do.
      reg.state.data[field] = before.value;
      reg.state.evidence[field] = before.evidence;
    }
    return { changed, problems };
  }

  /**
   * Take what a tool brought back and put it where it belongs.
   *
   * Two kinds of thing can come back, and they go opposite ways.
   *
   * `attach` is bytes. A photograph is sixty kilobytes of base64, and `data` is
   * read by four different things: the board stringifies every value into the
   * session instructions and pushes them on each change, tool results are
   * written to the trace and mirrored to the debug stream, and the result
   * itself goes back to the model. Bytes in `data` are bytes in all four. So
   * what lands in the form is the word `captured`; the value it stands for
   * lives beside it and is put back in exactly one place, submit_form, which is
   * the only thing that ever actually needed it.
   *
   * `fields` is values — a code the kiosk read, a record a lookup returned. It
   * is the mirror image: these DO belong in the form, so they travel the exact
   * road a spoken value travels, `state.save()` then `#verify()`. That is the
   * whole reason this is not a separate prefill path. A host that arrives on a
   * printed code is checked against the directory like a spoken one, a value
   * too long for its field is refused like a spoken one, and the result is
   * rewritten into the shape save_fields already returns — so the model reads a
   * tool that filled the form the same way it reads itself filling it, and
   * nothing new has to go in the instructions.
   *
   * Both are stripped from the result before the caller traces it or sends it
   * on. Neither goes through `state.correct()`: this is not a human overruling
   * the agent, and the `client` source is what tells a screen that nobody in
   * the room said this out loud.
   */
  async #absorb(reg, name, out) {
    if (!out || typeof out !== 'object') return out;
    let touched = false;

    if ('fields' in out) {
      const patch = out.fields;
      delete out.fields;
      touched = true;

      // A client that answers with junk must never throw — it simply brought
      // nothing. The CLI replies to every request it does not recognise with a
      // JPEG, and that is a client bug, not a reason to break the conversation.
      const fields = patch && typeof patch === 'object' && !Array.isArray(patch) ? { ...patch } : {};

      // Not the client's to fill either. A value invented here would satisfy
      // `missing`, and the tool that actually captures the thing would then
      // never be called — the same refusal save_fields applies to the model.
      const refused = Object.keys(fields).filter((f) => this.form.schema.properties?.[f]?.client);
      for (const f of refused) delete fields[f];

      // A scanned appointment is no more entitled to rename somebody than a
      // spoken sentence is.
      const gated = this.#gate(reg, fields);
      const { problems, changed } = reg.state.save(fields, {}, { source: 'client', via: name });
      for (const f of refused) problems.push(`${f}: not yours to fill; the kiosk captures it`);
      problems.push(...gated.problems);
      await this.#verify(reg, changed, problems);

      Object.assign(out, {
        saved: changed,
        missing: reg.state.missing(),
        ...(gated.proposed.length ? { pending_confirmation: gated.proposed } : {}),
        ...(problems.length ? { rejected: problems } : {}),
      });
    }

    if (out.attach) {
      for (const [field, value] of Object.entries(out.attach)) {
        reg.attachments.set(field, value);
        reg.state.data[field] = 'captured';
        reg.state.evidence[field] = { source: 'client', heard: null, via: name };
      }
      delete out.attach;
      touched = true;
    }

    if (touched) this.#publish(reg);
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
          { notes: this.notes, entries: this.#entries(), language: this.language }
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
       this.#send({ type: 'session.update', session: this.sessionConfig() });
   }

   /** The full session the Realtime API is configured with on connect. */
   sessionConfig() {
       return {
           type: 'realtime',
           output_modalities: [this.mode === 'text' ? 'text' : 'audio'],
           audio: {
               input: {
                   format: { type: 'audio/pcm', rate: 24000 },
                   // Let the model judge when a thought is finished instead of a
                   // silence timer. Handles "me llamo... Víctor Delgado" without a
                   // number to tune.
                   turn_detection: this.mode === 'text' ? null : { type: 'semantic_vad' },
                   transcription: transcriptionConfig(this.opts.transcriptionModel, this.language),
               },
               output: { format: { type: 'audio/pcm', rate: 24000 }, voice: this.opts.voice },
           },
           instructions: this.#instructions(),
           tools: buildTools(this.form, this.capabilities),
           tool_choice: 'auto',
       };
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
               // Cancelling a cover that finished generating a moment earlier.
               // Harmless — the server says so and carries on — and not something
               // the client should be told about.
               if (e.error?.code === 'response_cancel_not_active') return;
               return this.emit('error', new Error(e.error?.message || 'realtime error'));

           case 'conversation.item.input_audio_transcription.completed':
               return this.emit('transcript', { role: 'user', text: e.transcript });

           case 'response.created': {
               const r = this.#started(e.response);
               // Withdrawn before the server had named it; cancel it now.
               if (r?.withdrawn && e.response?.id) this.#send({ type: 'response.cancel', response_id: e.response.id });
               this.speaking = true;
               // Counted per response, not per item: the goodbye is measured to know
               // when it has finished playing.
               this.spokenBytes = 0;
               this.spokenAt = 0;
               this.emit('speaking', true);
               return;
           }

           case 'response.output_text.delta': {
               const r = this.#flightOf(e.response_id);
               if (r && !r.withdrawn) r.audible = true;
               return;
           }

           case 'response.output_item.added':
               this.audio = { itemId: e.item?.id, firstAt: 0, bytes: 0 };
               return;

           case 'response.output_audio.delta': {
               if (e.item_id && e.item_id === this.truncatedItem) return;   // stale, cut already
               const r = this.#flightOf(e.response_id);
               if (r?.withdrawn) return;                                    // taken back unheard
               if (r) r.audible = true;
               const buf = Buffer.from(e.delta, 'base64');
               if (this.audio) {
                   if (!this.audio.firstAt) this.audio.firstAt = Date.now();
                   this.audio.bytes += buf.length;
               }
               if (!this.spokenAt) this.spokenAt = Date.now();
               this.spokenBytes += buf.length;
               return this.emit('audio', buf);
           }

           case 'response.done': { // NOTE: This is where tools are called by the model
               // A response we cut off finishing is not the floor coming free:
               // the interjection that replaced it is already under way.
               const r = this.#landed(e.response);
               if (r?.cut) return this.#emitSaid(e.response);
               this.speaking = false;
               this.responsePending = false;
               this.emit('speaking', false);

               // A withdrawn cover said nothing anyone heard. Out of the
               // conversation it goes, and on with whatever was waiting.
               if (r?.withdrawn) {
                   for (const item of e.response?.output || []) {
                       if (item.id) this.#send({ type: 'conversation.item.delete', item_id: item.id });
                   }
                   return this.#onResponseDone({ ...e.response, output: [] });
               }

               return this.#onResponseDone(e.response); // NOTE: It's returning a promise!
           }
       }
   }

   /**
    * A response the server has started. Ours are matched to the oldest request
    * still waiting for an id; one we never asked for — the server's own turn
    * detection starts those — is simply recorded.
    */
   #started(response) {
       const id = response?.id ?? '?';
       const mine = this.flight.find((r) => r.id === null);
       if (mine) { mine.id = id; return mine; }
       const theirs = { id, cut: false, tag: null, audible: false, withdrawn: false };
       this.flight.push(theirs);
       return theirs;
   }

   /**
    * A response finished: take it off the list and say which one it was. An id
    * nothing matches (a replay, or a test that skips response.created) is taken
    * to be the oldest one whose id we never learned.
    */
   #landed(response) {
       let i = this.flight.findIndex((r) => r.id === response?.id);
       if (i < 0) i = this.flight.findIndex((r) => r.id === null || r.id === '?');
       return i < 0 ? null : this.flight.splice(i, 1)[0];
   }

   /** What the agent said in this response, for anyone keeping a transcript. */
   #emitSaid(response) {
       for (const item of response?.output || []) {
           if (item.type === 'message') {
               const text = (item.content || [])
                   .map((c) => c.text || c.transcript || '')
                   .join(' ')
                   .trim();
               if (text) this.emit('transcript', { role: 'agent', text });
           }
       }
   }

   async #onResponseDone(response) {
       this.#emitSaid(response);

       // The session is on its way out: either that turn was the goodbye, or it
       // was something holding the floor that the goodbye has been waiting for.
       if (this.ending) return void (this.#sayFarewell() || this.#finish());

       const calls = (response?.output || []).filter((i) => i.type === 'function_call');
       if (!calls.length) {
           // Something asked for the floor while this response had it.
           if (this.#next()) return;
           if (this.busy) return;                          // a blocking tool holds the floor
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

       // A form that filled up while a change to it is still undecided is not
       // ready to be read back. Its beat waits for the answer.
       for (const r of this.registrations.values()) {
           if (r.status === 'open' && r.state.complete && !r.beatDone && r.proposals.size
               && !before.get(r.id)?.complete) r.beatHeld = true;
       }

       // Somebody asked to change a value from their profile. Asking is forced
       // for the reason read-back is: a board line can be answered with a tool
       // call, and then the warning is never heard.
       const asking = [...this.registrations.values()].find(
           (r) => r.status === 'open' && [...r.proposals.values()].some((p) => !p.asked),
       );
       if (asking) return this.#requestResponse(this.#proposalBeat(asking));

       // Whichever registration just became complete gets its forced beat.
       const justCompleted = [...this.registrations.values()].find(
           (r) => r.status === 'open' && r.state.complete && !r.beatDone && !r.proposals.size
               && (!before.get(r.id)?.complete || r.beatHeld),
       );
       if (justCompleted) {
           justCompleted.beatHeld = false;
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

           const gated = this.#gate(reg, fields, args.quotes || {});
           const { problems, changed } = reg.state.save(fields, args.quotes || {}, { addressing });
           for (const f of refused) problems.push(`${f}: not yours to fill; the kiosk captures it`);
           problems.push(...gated.problems);
           await this.#verify(reg, changed, problems);
           
           this.#publish(reg);
           
           return {
               registration: reg.id,
               label: this.#labelOf(reg),
               saved: changed,
               missing: reg.state.missing(),
               ...(gated.proposed.length ? { pending_confirmation: gated.proposed } : {}),
               ...(problems.length ? { rejected: problems } : {}),
           };
       }

       if (name === 'submit_form') {
           const missing = reg.state.missing();
           if (missing.length) return { ok: false, registration: reg.id, missing };
           // Submitting now would send the profile's value while they are still
           // deciding whether to change it.
           if (reg.proposals.size) {
               return { ok: false, registration: reg.id, pending_confirmation: [...reg.proposals.keys()] };
           }
           try {
               const snapshot = reg.state.snapshot();
               // Tokens go back to being what they stand for. This is the only
               // place the real bytes leave `attachments` — the snapshot the
               // screen and the trace get still carries the token.
               const payload = { ...snapshot.data, ...Object.fromEntries(reg.attachments) };
               // `key` is how the integrator finds the user this record belongs
               // to. It rides beside the data, never in it: the model never sees it.
               const key = reg.personKey ?? null;
               const result = (await this.#call(this.form.submit, payload, { key })) || {};
               reg.status = 'submitted';
               reg.result = result;
               this.#advanceFocus(reg);
               this.emit('done', {
                   registration: reg.id, label: this.#labelOf(reg), key, ...snapshot, result,
               });
               return { ok: true, registration: reg.id, ...result };
           } catch (err) {
               return { ok: false, error: 'The registration system did not respond.' };
           }
       }

       if (name === 'skip_step') {
           // An optional step turned down. Recorded rather than acted on: the
           // board stops asking, and the tool stays available in case they find
           // the thing a minute later.
           const step = args.step;
           if (!reg.steps?.has(step)) {
               return {
                   ok: false,
                   error: `unknown step ${step ?? '(missing)'}`,
                   steps: [...(reg.steps?.keys() || [])],
               };
           }
           reg.steps.set(step, 'skipped');
           this.trace.write({ dir: 'tool', type: 'step.skipped', registration: reg.id, step, reason: args.reason });
           this.#scheduleBoard();
           return { ok: true, registration: reg.id, step, missing: reg.state.missing() };
       }

       if (name === 'confirm_change') {
           const field = args.field;
           if (!reg.proposals.has(field)) {
               return {
                   ok: false,
                   error: `nothing is waiting for confirmation on ${field ?? '(missing)'}`,
                   pending_confirmation: [...reg.proposals.keys()],
               };
           }
           const accept = args.accept === true;
           const { changed, problems } = await this.#settle(reg, field, accept, args.quote);
           this.#publish(reg);
           return {
               ok: true,
               registration: reg.id,
               field,
               saved: changed,
               missing: reg.state.missing(),
               ...(problems.length ? { rejected: problems } : {}),
           };
       }

       if (name === 'close_registration') {
           reg.status = 'closed';
           this.#advanceFocus(reg);
           this.trace.write({ dir: 'tool', type: 'closed', registration: reg.id, reason: args.reason });
           return { ok: true, registration: reg.id };
       }

       // The same filter buildTools used. A model that reaches for a tool this
       // client cannot serve gets `unknown tool`, not a live scanner.
       const customTool = availableTools(this.form, this.capabilities)
           .find((t) => t.definition.name === name);
       if (customTool) {
           // `ask` is how a form reaches the client. What it asks for, and what
           // it does with the answer, is the form's business; the engine only
           // carries it — and diverts whatever comes back as `attach`.
           // Absorbing is part of the wait, not something after it: a blocking
           // tool keeps the floor until its values have been verified too.
           const run = async () => {
               const out = await this.#absorb(reg, name, await this.#call(customTool.run, args, {
                   data: reg.state.data,
                   ask: (kind, payload) => this.ask(kind, payload),
               }));
               // Running it answers the question, whatever it brought back. A
               // reader that found nothing was still offered and still used.
               if (reg.steps?.get(name) === 'pending') {
                   reg.steps.set(name, 'done');
                   this.#scheduleBoard();
               }
               return out;
           };

           try {
               return modeOf(customTool.run)?.hold ? await this.#holdFloor(run) : await run();
           }
           catch (err) {
               return { ok: false, error: String(err.message || err) };
           }
       }

       return { ok: false, error: `unknown tool ${name}` };
   }
}
