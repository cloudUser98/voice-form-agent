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
a booking id — passes it at construction. The agent has no concept of where it
came from.

This is for what you know *before* anybody speaks. Something the kiosk has to go
and fetch during the conversation — a photograph, a scanned code — is a
capability instead; see the next section. The difference matters: `prefill`
skips `verify`, which is right for our own camera and wrong for anything an
outside system produced.

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

## Asking the client for something

Some values cannot be spoken. A photograph, a code printed by somebody else's
system, a card read by a reader — the person at the kiosk cannot say those out
loud, and the agent cannot invent them. So the agent asks the client for them.

The engine never learns what any of it *is*. It forwards a word and waits for an
answer, the same way it would ask for the time. Everything about cameras, QR
codes and readers lives in the form on one side and in the client on the other.

### The three parts

| Where | What | Example |
|---|---|---|
| the tool, in `forms/` | `needs: '<capability>'` — what it requires of the client | `needs: 'code'` |
| the client, at `start` | `capabilities: [...]` — what it can be asked for | `['photo', 'code']` |
| the client, at runtime | answers `{type:'request'}` with `{type:'answer'}` | the decoded string |

A tool whose `needs` is not in `capabilities` is **never shown to the model** and
is refused if the model asks for it anyway. So the agent cannot offer something
that cannot happen — there is no prose to write about it and nothing to say out
loud. The tool simply is not there.

Declaring nothing means having everything. A client that has not been taught to
send `capabilities` keeps working exactly as it did.

### Worked example: a QR reader

**1. The form declares the tool** (`forms/visit.js`). `ask` is how a form reaches
the client; `blocking` means the visitor is told to wait and the microphone stays
shut until the answer is back.

```js
const scanCode = {
  needs: 'code',                       // this is the capability word
  definition: {
    type: 'function',
    name: 'scan_code',
    description: 'Lee el código de cita con el lector del kiosco...',
    parameters: { /* one `registration` id, read off the board */ },
  },

  run: blocking(async ({ registration }, { ask }) => {
    const code = String((await ask('code', { registration })) ?? '').trim();
    if (!code) return { ok: false, error: 'El lector no devolvió ningún código.' };

    const cita = await lookupAppointment(code);    // forms/api.js — the engine never imports it
    if (!cita.ok) return cita;

    return { ok: true, fields: { codigo: code, ...cita.fields } };
  }, {
    say: 'Pídeles en UNA frase que acerquen su código al lector y esperen un momento.',
    timeoutMs: Infinity,
  }),
};
```

Note what comes back from the reader: **a string, not a form**. What the code
means is the server's to decide, and `lookupAppointment` exchanges it for the
visit. A code that carried the visit itself would make the kiosk an authority on
who is visiting whom, and a printer enough to forge one.

**2. The client says it has a reader**, once, in `start`:

```js
ws.send(JSON.stringify({
  type: 'start', form: 'visit', capabilities: ['photo', 'code'],
}));
```

**3. The client answers when asked.** One handler for every kind:

```js
if (e.type === 'request') {
  const value = e.kind === 'photo' ? await capture()
              : e.kind === 'code'  ? await readCode()
              : null;
  ws.send(JSON.stringify({ type: 'answer', id: e.id, value }));
}
```

`e.id` is what pairs the answer with the question, and `e.registration` says who
it is for when several people are being registered at once.

That is the whole integration. What it sounds like:

```
🤖 ¿Traes tu código de cita?
👤 Sí, aquí lo tengo.
🤖 Acércalo al lector y espera un momento.
   >>> {type:'request', kind:'code', id:'q1', registration:'r1'}
   <<< {type:'answer', id:'q1', value:'CITA-1234'}
🤖 Perfecto, Ana. Ya tengo tus datos — solo falta la foto.
```

### Where the answer goes: `fields` or `attach`

A tool returns one of two things, and they go opposite ways.

| Return | For | What happens |
|---|---|---|
| `fields: {...}` | values that belong in the form | goes through `save_fields`' exact road: schema validation, then `verify` |
| `attach: {...}` | bytes | the form gets the token `captured`; the real value is held aside and merged back in `submit_form` alone |

`fields` is the important one. It is **not** a second write path — the patch goes
through `state.save()` and then `#verify()`, so a host that arrived on a scanned
code is checked against the staff directory exactly like a host said out loud,
and a value too long for its field is refused exactly like a spoken one:

```
scan_code → {"ok":true,"saved":["codigo","visitante","procedencia","motivo"],
             "missing":["anfitrion","foto"],
             "rejected":["anfitrion: No aparece nadie con ese nombre en el directorio."]}
```

The agent then asks for the host out loud. This is why there is no `prefillers`
list: anything arriving from outside gets checked, or the printer becomes the
authority on who works here.

`attach` exists because `data` is restated into the session instructions on every
change, written to the trace and mirrored to the debug stream — sixty kilobytes
of base64 in `data` is sixty kilobytes in all four.

### Asking for it first

A tool may add one more key:

```js
opening: 'Pregúntales en UNA frase si traen su código de cita; si no lo traen, no pasa nada.',
```

The question is then put in the greeting turn, before anything else, and the
model is forbidden from calling any tool until they answer — so the visitor
always gets the chance to say no. Declining is a real answer: the model calls
`skip_step` and the board stops raising it.

Asked once is **not** available once. The tool stays callable and its field stays
on the board, so somebody who finds their code three questions later still gets
to use it. Use `opening` for ordering — a code answered at the door saves four
questions and the same code answered at the end saves none — never as a deadline.

### Rules worth knowing

- **Always answer a request.** With the value, or with `null`. There is no
  deadline at the engine end, by design: it has no basis for guessing how long
  somebody needs to find a piece of paper, and the client is the only thing that
  knows its reader stopped responding. A client that goes quiet is
  indistinguishable from one still thinking, and holds that registration open.
- **Capabilities are fixed at `start`.** They are read once and never re-read;
  the browser client disables its checkbox as soon as the session begins.
- **Nobody listening answers for itself.** With no client attached, `ask`
  resolves `null` rather than hanging — which is what lets `mode:'text'`, the CLI
  and the whole offline suite run with no kiosk at the other end. Write the tool
  so `null` is a sentence the agent can say, as `scan_code` does above.
- **A tool cannot write a `client: true` field.** Those are captured, not
  computed; a value invented for one would satisfy `missing` and the tool that
  actually captures it would never be called.
- **Use the same word everywhere.** The `needs` of the tool, the `kind` of the
  request and the entry in `capabilities` are one string. `photo` and `code` are
  the two that exist today; add whatever your client can do.

## Wire protocol

One WebSocket. Binary frames are PCM16 mono 24 kHz, both directions. Text frames
are JSON.

| Direction | Message |
|---|---|
| → | `{type:'start', form, prefill?, notes?, mode?, capabilities?}` |
| → | binary audio · `{type:'text', text}` · `{type:'interrupt'}` |
| → | `{type:'correct', field, value}` — human overrules a value |
| → | `{type:'detected', event}` — the room changed; this is what creates registrations |
| → | `{type:'answer', id, value}` — the client's reply to a `request` |
| ← | binary audio |
| ← | `{type:'request', id, kind, registration}` — the agent needs something only the client can get |
| ← | `{type:'ready'\|'waiting'\|'transcript'\|'state'\|'idle'\|'interrupted'\|'done'\|'error'}` |

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