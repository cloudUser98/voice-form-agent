# voice-form-agent

A headless realtime voice agent that fills **any** form defined as a JSON Schema.

It has no idea what a kiosk, a camera or an avatar is. You give it a form and
whatever you already know about the person in front of it; it holds a natural
spoken conversation until the form is complete, then submits.

```
   browser          CLI            test script
      └───────────────┼─────────────────┘
              WebSocket (audio + JSON)
                      │
              ┌───────▼────────┐
              │  FormAgent     │  save_fields · submit_form
              └───────┬────────┘
                      │
            OpenAI Realtime (gpt-realtime)
```

## Run it

```bash
npm install
echo "OPENAI_API_KEY=sk-..." > .env

npm run serve                  # ws://localhost:8787
npm run cli visit              # type at it in the terminal
npx serve clients/web          # or talk to it in a browser
```

## Defining a form

A form is a persona paragraph plus a standard JSON Schema. That is the whole
configuration surface — there is no DSL to learn.

```js
export default {
  name: 'visit',
  language: 'es',
  voice: 'marin',

  persona: `Eres la recepcionista de un corporativo en México...`,

  schema: {
    type: 'object',
    required: ['visitantes', 'procedencia', 'motivo', 'anfitrion'],
    properties: {
      visitantes:  { type: 'array', items: { type: 'string' }, description: 'Nombre de cada persona.' },
      procedencia: { type: 'string', description: 'Empresa de la que vienen.' },
      // ...
    },
  },

  async submit(data) { return { folio: await registerVisit(data) }; },
};
```

Drop the file in `forms/`, and `{"type":"start","form":"yourform"}` uses it.
`forms/hotel.js` is a second, unrelated domain running on the same engine.

### Why field `description` matters

Descriptions are not documentation — they are the instructions the model reads
when deciding what a spoken sentence means. Write them for the model.

## How it decides what to ask

There is no state machine. The agent has two tools:

| Tool | Returns |
|---|---|
| `save_fields(patch)` | `{ saved, missing, rejected? }` |
| `submit_form()` | `{ ok, ...result }` or `{ ok:false, missing }` |

The `missing` array in every tool result is what steers the conversation. The
model reads "you still need `anfitrion`" and asks for it, in its own words, in
whatever order the conversation naturally went. Validation is in memory against
the schema; anything invalid comes back as `rejected` with a reason and the
model asks again.

Corrections need no special handling: `save_fields` overwrites. For list fields
the model sends the whole list.

## Prefilled context

Anything that knows something before the conversation starts — a face detector,
a QR scan, a booking ID — passes it at construction. The agent has no concept of
where it came from.

```js
new FormAgent({
  form: visit,
  prefill: { visitantes: ['Víctor Delgado'] },
  notes: 'La cámara reconoció a Víctor Delgado, que ya ha visitado antes.',
});
```

`prefill` seeds the form state so those fields are never asked for. `notes` is
free text the agent uses to greet appropriately. If it's wrong, the visitor
corrects it and the correction overwrites.

## Wire protocol

One WebSocket. Binary frames are PCM16 mono 24 kHz, both directions. Text frames
are JSON.

| Direction | Message |
|---|---|
| → | `{type:'start', form, prefill?, notes?, mode?}` |
| → | binary audio · `{type:'text', text}` · `{type:'interrupt'}` |
| ← | binary audio |
| ← | `{type:'ready'\|'transcript'\|'state'\|'idle'\|'interrupted'\|'done'\|'error'}` |

`mode:'text'` runs the same agent with typed input and no audio. That is what
makes it testable, and what an IDE or chat client would use.

## Tests

```bash
node --test test/validate.test.js       # offline, instant
npm test                                # live: real API, real conversations
```

The live tests script whole conversations in text mode and assert on the final
form state — including a self-correction and a prefilled session. They cost a
few cents and test what actually ships.

## Traces

Every session writes `traces/<session>.jsonl` containing every event in both
directions, ours and OpenAI's, with audio deltas reduced to byte counts. When a
conversation goes wrong, read the file. `TRACE=off` disables it.

## Notes

- Turn detection is `semantic_vad`: the model judges when a thought is finished
  rather than a silence timer, so "me llamo… Víctor Delgado" survives the pause.
- Barge-in is handled: `input_audio_buffer.speech_started` cancels the response
  and emits `interrupted` so the client flushes its playback buffer.
- In a noisy room an open microphone will still pick up bystanders. That is a
  hardware problem (directional mic) before it is a software one; if you need a
  software gate, mute the mic between `response.created` and `idle`.
