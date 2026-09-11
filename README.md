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

### A field the world has to agree with

Some values are not ours to accept. `anfitrion` has to be somebody who actually
works here, and only the staff directory knows that. A field says so with
`verify`:

```js
anfitrion: {
  type: 'string',
  description: 'Nombre de la persona a la que visitan.',
  verify: blocking(lookupHost, {
    say: (name) => `Di que estás viendo si ${name} puede recibirlos.`,
    timeoutMs: 6000,
  }),
}
```

It runs **inside `save_fields`**, which is the only road a spoken value travels —
so the check cannot be skipped, and it costs no extra tool call. `blocking` means
the visitor hears *"déjame ver si Carlos puede recibirte"* and the microphone
stays shut until the answer is back.

```
👤 Vengo a ver a Rodrigo Salinas.
🤖 Déjame ver si Rodrigo Salinas puede recibirte, un momento.
   ...
🤖 No encuentro a nadie con ese nombre, ¿me lo repites?
```

`verify` returns `{ok:true}` or `{ok:false, error}`, and **every** failure is the
second one — not in the directory, endpoint down, timeout, junk payload. The
field is cleared and the reason joins the same `rejected` array a schema
violation uses, so the board says `anfitrion` is missing again and the agent
asks. A check that throws is a refusal too; a form cannot break a save.

A staff `correct()` and a camera prefill come from outside the conversation and
are never second-guessed. The endpoints themselves live in `forms/api.js` — the
engine never imports it.

## Catching a value the agent got wrong

Models hallucinate. Rather than trying to prevent it with guards that also
reject valid answers, the agent makes every value **checkable by a human** and
**fixable without interrupting the conversation**.

### 1. Every value says what it came from

`save_fields` takes an optional `quotes` map — the words the visitor actually
used. It is display data: never validated, never used to reject a value. The
model is told outright that nothing is checked against it, so it has no reason
to fabricate one. Each field ends up tagged:

| source | meaning |
|---|---|
| `heard` | the visitor said it, and the quote is there to prove it |
| `inferred` | the agent worked it out — **check this one** |
| `prefill` | came from outside; nobody said it |
| `corrected` | a human overruled the agent |

```
visitantes   = ["Ana Ruiz"]   [heard] “Soy Ana Ruiz”
procedencia  = "Bimbo"        [heard] “vengo de Bimbo”
anfitrion    = "Laura Mendoza"[inferred] (no quote)     ← nobody said "Mendoza"
```

The browser client renders this as a live table; amber rows are the ones worth
reading. This is the same information the old quote-grounding harness collected,
used the opposite way: **shown to a person instead of enforced against the
model.** No valid answer ever gets rejected.

### 2. Anyone can overrule it, mid-conversation

```js
agent.correct('procedencia', 'Grupo Lala');   // or {type:'correct'} over the socket
```

Writes straight to the form, marks it `corrected`, and quietly tells the model
the new value is the truth. It does **not** make the agent speak, so fixing a
misheard name never interrupts anything. Observed:

```
👤 Soy Ana Ruiz y vengo de Bimbo.
   >>> correct('procedencia', 'Grupo Lala')
🤖 Te registraste como visitante de Grupo Lala.
   Y seguimos: ¿cuál es el motivo de tu visita?
```

It adopted the new value, never mentioned the correction, and carried on with
the question it was already asking. Invalid corrections are refused against the
schema (`{ok:false, error:'procedencia: too short'}`), so the escape hatch can't
put junk in the form either.

In the browser client, click any value to edit it.

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
| → | `{type:'correct', field, value}` — human overrules a value |
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


## References

- Documentation for the OpenaiAI stack lives in (we are not using the Agent SDK):
    - https://developers.openai.com/api/docs/guides/voice-websockets?api=realtime
    - https://developers.openai.com/api/docs/guides/realtime-conversations#handling-audio-with-websockets