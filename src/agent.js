import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { buildInstructions, buildTools, nextAction } from './prompt.js';
import { FormState } from './form-state.js';
import { openTrace } from './trace.js';

const REALTIME_URL = 'wss://api.openai.com/v1/realtime';

/**
 * A headless voice agent that fills one form.
 *
 * Audio in / audio out plus a few events. It knows nothing about browsers,
 * kiosks, cameras or avatars — whatever put a caller in front of it passes
 * what it already knows as `prefill` and `notes`, and that is the entire
 * integration surface.
 *
 * Events: 'open' | 'audio' (Buffer pcm16) | 'transcript' {role,text}
 *         'state' {data,missing} | 'focus' {registration} | 'idle'
 *         'speaking' bool | 'done' {data}
 *         'debug' (every event, for the inspector) | 'error' | 'close'
 *
 * The conversation is half duplex: the agent never listens while it talks, and
 * is never interrupted.
 */
export class FormAgent extends EventEmitter {
  constructor({
    form,
    prefill = {},
    notes = '',
    label = '',                         // who the first form is for, if known
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

    // One registration per person. r1 always exists — the agent is always
    // talking to somebody — so the single-visitor path is unchanged and
    // start_registration only ever adds FURTHER people.
    this.registrations = new Map();
    this.nextId = 1;
    this.focused = this.#open({ label, prefill }).id;   // who the agent is addressing
    this.sessionId = sessionId;
    this.speaking = false;
    this.responsePending = false;       // we asked for a response, none finished yet
    this.queued = false;                // something wanted the floor while busy
    this.pendingNudge = false;          // a room event that still needs a reply
    this.opts = { apiKey, model, voice };
    this.trace = openTrace(sessionId, { form: form.name, prefill, notes, mode });
  }

  start() {
    const { apiKey, model } = this.opts;
    this.ws = new WebSocket(`${REALTIME_URL}?model=${encodeURIComponent(model)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    this.ws.on('open', () => this.#configure());
    this.ws.on('message', (raw) => this.handleEvent(JSON.parse(raw)));
    this.ws.on('error', (err) => this.emit('error', err));
    this.ws.on('close', () => { this.trace.close(); this.emit('close'); });
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
    if (this.speaking) return;
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
    const reg = this.#resolve(registration);
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
   * Somebody new is in the room. Greeting them is a conversational decision, so
   * this only supplies the fact; the model decides how to welcome them.
   */
  personArrived({ label = '', notes = '' } = {}) {
    this.#roomEvent(`${label || 'Someone'} has just arrived at reception.`
      + (notes ? ` ${notes}` : '')
      + ' Greet them briefly now and call start_registration so they are on the board,'
      + ' but do not ask them any questions until the registration in progress is submitted or closed.');
  }

  /** Somebody walked out. If they had a form open, the agent should ask. */
  personLeft({ label = '' } = {}) {
    const reg = [...this.registrations.values()]
      .find((r) => r.status === 'open' && this.#labelOf(r) === label);
    this.#roomEvent(`${label || 'Someone'} has left reception.`
      + (reg ? ` Their registration ${reg.id} is unfinished. Ask whether to carry on with it or close it.` : ''));
  }

  close() { clearTimeout(this.boardTimer); this.ws?.close(); }

  // ---------------------------------------------------------------- internals

  #send(event) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(event)); }

  /**
   * Everything that happens, to the trace file and to anyone watching live.
   * Base64 audio is reduced to a size so the stream stays readable.
   */
  #record(entry) {
    this.trace.write(entry);
    this.emit('debug', typeof entry.delta === 'string' && entry.delta.length > 80
      ? { ...entry, delta: `<${entry.delta.length} b64 chars>` }
      : entry);
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

  /** Create a registration. Also the reason r1 exists before anyone speaks. */
  #open({ label = '', prefill = {} } = {}) {
    const id = `r${this.nextId++}`;
    const reg = {
      id,
      label,
      state: new FormState(this.form.schema, { prefill, label }),
      status: 'open',
      result: null,
      beatDone: false,
    };
    this.registrations.set(id, reg);
    return reg;
  }

  /**
   * Which registration a tool call meant. A missing id resolves to the only
   * open one — a model that forgets the argument in a one-visitor conversation
   * should not produce an error the visitor can hear.
   */
  #resolve(id) {
    if (id) return this.registrations.get(id) || null;
    const focused = this.registrations.get(this.focused);
    if (focused?.status === 'open') return focused;
    const open = [...this.registrations.values()].filter((r) => r.status === 'open');
    return open.length === 1 ? open[0] : null;
  }

  /** The name to show and to call the person by. */
  #labelOf(reg) {
    return reg.label || reg.state.data[this.form.labelFrom] || '';
  }

  #publish(reg) {
    // A correction that empties a required field earns a fresh confirmation.
    if (!reg.state.complete) reg.beatDone = false;
    this.emit('state', {
      registration: reg.id,
      label: this.#labelOf(reg),
      ...reg.state.snapshot(),
    });
    this.#scheduleBoard();
  }

  /**
   * A fact from the room, injected without making the agent speak over itself.
   * If it is mid-sentence the reply waits for the turn to end.
   */
  #roomEvent(text) {
    this.#record({ dir: 'room', text });
    this.#send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] },
    });
    if (this.speaking || this.responsePending) { this.pendingNudge = true; return; }
    this.#requestResponse();
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
   * The turn where the form has just become complete, forced to be speech.
   *
   * `tool_choice: 'none'` makes tool calls impossible for this one response, so
   * the model cannot reach for submit_form and skip the confirmation — the
   * failure stops being something it can do, rather than something we ask it
   * not to. Returns null when the form submits silently.
   */
  #completionBeat(reg) {
    if (!this.form.onComplete) return null;
    return {
      tool_choice: 'none',
      // Per-response instructions REPLACE the session's rather than merging,
      // so the persona has to travel with them or the agent drops character
      // for this turn and reads the record out like a spreadsheet.
      instructions: [
        this.form.persona.trim(),
        '',
        nextAction(this.form, { label: this.#labelOf(reg), state: reg.state }),
        '',
        `Datos registrados: ${JSON.stringify(reg.state.snapshot().data)}`,
      ].join('\n'),
    };
  }

  #instructions() {
    return buildInstructions(this.form, { notes: this.notes, entries: this.#entries() });
  }

  /**
   * Rewrite the status block the model reads. Pushing it costs a round trip, so
   * out-of-band changes (a staff correction) are debounced and never land in
   * the middle of a response.
   */
  #scheduleBoard() {
    clearTimeout(this.boardTimer);
    this.boardTimer = setTimeout(() => {
      if (this.speaking) return this.#scheduleBoard();
      this.#flushBoard();
    }, 250);
  }

  /**
   * Push it right now. Used after tool calls, where the board MUST be current
   * before the model gets the floor back — that is the exact turn where a form
   * has just become complete.
   */
  #flushBoard() {
    clearTimeout(this.boardTimer);
    this.boardTimer = null;
    if (!this.ready) return;
    this.#send({
      type: 'session.update',
      session: { type: 'realtime', instructions: this.#instructions() },
    });
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
  handleEvent(e) {
    this.#record({ dir: 'openai', ...e });

    switch (e.type) {
      case 'session.updated':
        if (!this.ready) { this.ready = true; this.emit('open'); this.#greet(); }
        return;

      case 'error':
        return this.emit('error', new Error(e.error?.message || 'realtime error'));

      case 'conversation.item.input_audio_transcription.completed':
        return this.emit('transcript', { role: 'user', text: e.transcript });

      case 'response.created':
        this.speaking = true;
        this.emit('speaking', true);
        return;

      case 'response.output_audio.delta':
        return this.emit('audio', Buffer.from(e.delta, 'base64'));

      case 'response.done':
        this.speaking = false;
        this.responsePending = false;
        this.emit('speaking', false);
        return this.#onResponseDone(e.response);
    }
  }

  #greet() {
    // One nudge to open the conversation. Everything after this is driven by
    // the visitor speaking.
    this.#requestResponse();
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

    const calls = (response?.output || []).filter((i) => i.type === 'function_call');
    if (!calls.length) {
      // A room event that arrived mid-sentence has been waiting for the floor.
      if (this.pendingNudge) { this.pendingNudge = false; return this.#requestResponse(); }
      if (this.queued) { this.queued = false; return this.#requestResponse(); }
      return this.emit('idle');                        // agent finished its turn
    }

    const before = new Map([...this.registrations].map(([id, r]) => [id, r.state.complete]));

    for (const call of calls) {
      let args = {};
      try { args = JSON.parse(call.arguments || '{}'); } catch { /* model sent junk; treated as empty */ }
      const result = await this.#runTool(call.name, args);
      this.#record({ dir: 'tool', name: call.name, args, result });
      this.#send({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) },
      });
    }

    // The board must be current BEFORE the model speaks again: this is the
    // turn where a form may have just become complete.
    this.#flushBoard();
    this.pendingNudge = false;

    // Whichever registration just became complete gets its forced beat.
    const justCompleted = [...this.registrations.values()].find(
      (r) => r.status === 'open' && r.state.complete && !r.beatDone && !before.get(r.id),
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

    if (name === 'start_registration') {
      const open = [...this.registrations.values()].filter((r) => r.status === 'open');
      if (open.length >= this.maxOpen) {
        return { ok: false, error: `too many open registrations (limit ${this.maxOpen})` };
      }
      const reg = this.#open({ label: String(args.label || '').trim() });
      this.#publish(reg);
      return { registration: reg.id, label: this.#labelOf(reg) };
    }

    // Everything below is about one specific person.
    const reg = this.#resolve(args.registration);
    if (!reg) {
      return {
        ok: false,
        error: `unknown registration ${args.registration ?? '(missing)'}`,
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

      const { problems, changed } = reg.state.save(args.fields || {}, args.quotes || {}, { addressing });
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
        const result = (await this.form.submit?.({ ...snapshot.data })) || {};
        reg.status = 'submitted';
        reg.result = result;
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
      if (this.focused === reg.id) {
        const next = [...this.registrations.values()].find((r) => r.status === 'open');
        if (next) { this.focused = next.id; this.emit('focus', { registration: next.id, label: this.#labelOf(next) }); }
      }
      this.trace.write({ dir: 'tool', type: 'closed', registration: reg.id, reason: args.reason });
      return { ok: true, registration: reg.id };
    }

    const custom = (this.form.tools || []).find((t) => t.definition.name === name);
    if (custom) {
      try { return await custom.run(args, { data: reg.state.data }); }
      catch (err) { return { ok: false, error: String(err.message || err) }; }
    }

    return { ok: false, error: `unknown tool ${name}` };
  }
}
