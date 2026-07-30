import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { buildInstructions, buildTools } from './prompt.js';
import { applyPatch, missingFields } from './validate.js';
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
 *         'state' {data,missing} | 'idle' | 'interrupted' | 'done' {data}
 *         'error' | 'close'
 */
export class FormAgent extends EventEmitter {
  constructor({
    form,
    prefill = {},
    notes = '',
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
    this.data = { ...prefill };
    this.notes = notes;
    this.sessionId = sessionId;
    this.submitted = false;
    this.speaking = false;
    this.opts = { apiKey, model, voice };
    this.trace = openTrace(sessionId, { form: form.name, prefill, notes, mode });
  }

  start() {
    const { apiKey, model } = this.opts;
    this.ws = new WebSocket(`${REALTIME_URL}?model=${encodeURIComponent(model)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    this.ws.on('open', () => this.#configure());
    this.ws.on('message', (raw) => this.#onEvent(JSON.parse(raw)));
    this.ws.on('error', (err) => this.emit('error', err));
    this.ws.on('close', () => { this.trace.close(); this.emit('close'); });
    return this;
  }

  /** Raw PCM16 mono 24kHz from whatever is holding the microphone. */
  sendAudio(chunk) {
    this.#send({ type: 'input_audio_buffer.append', audio: Buffer.from(chunk).toString('base64') });
  }

  /** Typed input — same conversation, no microphone. Makes the agent testable. */
  sendText(text) {
    this.#send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    });
    this.trace.write({ dir: 'in', type: 'user.text', text });
    this.#send({ type: 'response.create' });
  }

  /** Stop talking right now (someone started speaking, or the caller hung up). */
  interrupt() {
    if (!this.speaking) return;
    this.#send({ type: 'response.cancel' });
    this.speaking = false;
    this.emit('interrupted');
  }

  close() { this.ws?.close(); }

  // ---------------------------------------------------------------- internals

  #send(event) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(event)); }

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
        instructions: buildInstructions(this.form, { notes: this.notes, data: this.data }),
        tools: buildTools(this.form),
        tool_choice: 'auto',
      },
    });
  }

  #onEvent(e) {
    this.trace.write({ dir: 'openai', ...e });

    switch (e.type) {
      case 'session.updated':
        if (!this.ready) { this.ready = true; this.emit('open'); this.#greet(); }
        return;

      case 'error':
        return this.emit('error', new Error(e.error?.message || 'realtime error'));

      case 'input_audio_buffer.speech_started':
        return this.interrupt();                       // barge-in

      case 'conversation.item.input_audio_transcription.completed':
        return this.emit('transcript', { role: 'user', text: e.transcript });

      case 'response.created':
        this.speaking = true;
        return;

      case 'response.output_audio.delta':
        return this.emit('audio', Buffer.from(e.delta, 'base64'));

      case 'response.done':
        this.speaking = false;
        return this.#onResponseDone(e.response);
    }
  }

  #greet() {
    // One nudge to open the conversation. Everything after this is driven by
    // the visitor speaking.
    this.#send({ type: 'response.create' });
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
    if (!calls.length) return this.emit('idle');       // agent finished its turn

    for (const call of calls) {
      let args = {};
      try { args = JSON.parse(call.arguments || '{}'); } catch { /* model sent junk; treated as empty */ }
      const result = await this.#runTool(call.name, args);
      this.trace.write({ dir: 'tool', name: call.name, args, result });
      this.#send({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) },
      });
    }

    // The model is waiting on those results — give it the floor back.
    if (!this.submitted) this.#send({ type: 'response.create' });
  }

  async #runTool(name, args) {
    const { schema } = this.form;

    if (name === 'save_fields') {
      const { problems, changed } = applyPatch(schema, this.data, args);
      const missing = missingFields(schema, this.data);
      this.emit('state', { data: { ...this.data }, missing });
      return {
        saved: changed,
        missing,
        ...(problems.length ? { rejected: problems } : {}),
        ...(missing.length ? {} : { hint: 'Everything required is filled. Call submit_form.' }),
      };
    }

    if (name === 'submit_form') {
      const missing = missingFields(schema, this.data);
      if (missing.length) return { ok: false, missing, hint: 'Ask for these before submitting.' };
      try {
        const result = (await this.form.submit?.({ ...this.data })) || {};
        this.submitted = true;
        this.emit('done', { data: { ...this.data }, result });
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, error: 'The registration system did not respond.' };
      }
    }

    const custom = (this.form.tools || []).find((t) => t.definition.name === name);
    if (custom) {
      try { return await custom.run(args, { data: this.data }); }
      catch (err) { return { ok: false, error: String(err.message || err) }; }
    }

    return { ok: false, error: `unknown tool ${name}` };
  }
}
