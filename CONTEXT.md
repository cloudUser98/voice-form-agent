# voice-form-agent — context

A headless realtime **voice agent that fills any form defined as JSON Schema**.
A corporate receptionist is one use case; `forms/hotel.js` proves the same
engine runs a different domain with zero code changes.

Node 20+, ESM. Talks to the OpenAI Realtime API (`gpt-realtime-2.1`) over a raw
WebSocket — no Agents SDK, no framework. ~3000 lines total, replacing a 4800-line
predecessor that collapsed under its own harness.

## Files

    src/agent.js       FormAgent — owns the realtime session, tools, registrations
    src/form-state.js  one form being filled. Pure: no sockets, no events
    src/prompt.js      persona + schema -> instructions; builds "the board"
    src/validate.js    minimal JSON Schema checks
    src/tools.js       blocking / deferred / background decorators
    src/detector.js    adapter for the external face-recognition service
    src/user.js        user schemas: load checks, record -> arrival, protection rules
    src/server.js      WebSocket transport (only file that opens ports)
    src/trace.js       JSONL of every event, per session
    forms/*.js         a form = persona paragraph + JSON Schema + submit()
    forms/api.js       the endpoints a form calls out to. The engine never imports it
    users/*.js         user schemas a form imports as `user` (shared across forms)
    clients/           browser (mic + inspector) and CLI
    detector-sim.js    fake camera service; `npm run dev:detector`, press c/d/g

## How it works

**The board.** Session instructions carry a live status block listing every open
registration, its values and what's still missing. Rebuilt and pushed via
`session.update` on every change — one copy, never stale. *Tool results report
facts; the board directs.*

**Tools** (`focus`, `save_fields`, `submit_form`, `open_registrations`,
`close_registration`) are registration-scoped. The `missing` array in each result
is what steers the conversation — there is no state machine.

**A field the world has to agree with.** A schema field may carry `verify` — an
async check that runs *inside* `save_fields`, the only road a spoken value
travels, so it cannot be skipped. A refusal clears the field and joins the same
`rejected` array a schema violation uses; the board then asks for it again.
Every failure is a refusal (not found, 500, timeout, throw). `correct()` and
prefill skip it — they come from outside the conversation.

**A field only the client can fill.** A field may carry `client: true`, and then
nobody in the conversation can fill it — not the visitor, who cannot say a
photograph out loud, and not the model, which is left out of `save_fields`'
parameters and refused if it writes there regardless. It arrives through a form
tool calling `ask('photo', …)`: a request the transport forwards to whoever
holds the client, waited on with **no deadline**, because somebody still walking
up to the camera is not a failure. What lands in the form is the token
`captured`; the bytes live in `reg.attachments` and are merged back in
`submit_form` alone. That split is the entire point — `data` is restated into
the session instructions on every change, written to the trace and mirrored to
the debug stream, so base64 in `data` is base64 in all four. Nobody listening
means nobody can answer, so `ask` resolves empty; that is what lets text mode
and the offline suite run with no client at the other end.

**A tool that fills fields.** The mirror image of `attach`: a form tool may come
back with `fields`, and that patch goes through `state.save()` and then
`#verify()` — the exact road a spoken value travels, in `#absorb`. So a host
that arrived on a scanned code is checked against the directory like a spoken
one, a value too long for its field is refused like a spoken one, and the result
is rewritten into the `{saved, missing, rejected}` shape `save_fields` already
returns, so nothing new has to go in the instructions. Evidence records
`{source:'client', via:'<tool>'}`, because nobody in the room said it out loud.
This is why there is no second "prefill" path: constructor `prefill` skips
`verify` — right for our own camera, wrong for anything printed by an outside
system. A tool's patch may not touch a `client: true` field; the kiosk captures
those, and a value invented for one would satisfy `missing` and stop the tool
that actually captures it ever being called.

**What the client can do.** A form tool may declare `needs: '<capability>'` — the
same word `ask` uses as its `kind` — and a client declares `capabilities: [...]`
in its `start` message. A tool the client cannot serve is never shown to the
model and is refused by `#runTool`, so the agent can never offer something that
cannot happen; there is no prose to write about it, the tool simply is not
there. Declaring nothing means having everything, which is what keeps a client
that has not been taught to say so, and the whole offline suite, working
unchanged.

**A question asked first.** A tool may carry `opening: '<directive>'`, and then
it is put in the arrival turn, riding along with the greeting — with
`tool_choice:'none'`, so the model must ask before it can act. It is recorded
per registration in `reg.steps`, described on the board while pending, and
resolved by calling the tool or by calling `skip_step`. `scan_code` uses it: a
code answered at the door saves four questions, and the same code answered at
the end saves none.

It buys ordering and nothing else, which is the distinction that cost us a
week. Asked once is not available once. The first version paired `opening` with
a twenty-second deadline, so the question and the tool expired together and
whoever was slowest to find their code had lost both with no way back. Now the
tool waits as long as the client takes, a skip leaves `codigo` on the board as
an empty optional field, and the tool stays callable — so somebody who finds
their code three questions later still gets to use it. `opening` means ask this
first and do not nag; it never means this is your one chance.

**Known users.** A form may import a user schema as `user` (`src/user.js`,
`users/visitor.js`). An arrival is `{key, prefill, protect}` whichever connector
produced it: `agent.arrive(record)` / `{type:'arrive', user}` for an integrator,
`toPerson()` for the camera. A record that does not fit is refused outright — no
registration, no session. Only `prefill: true` fields the form has are prefilled;
the key and everything else stay out of the model. A prefilled value may be
`readOnly` (refused, `beforeUpdate` says why) or `confirmOnly`: `#gate` takes it out
of the patch on both write paths (`save_fields` and a tool's `fields`) and parks a
proposal; `#proposalBeat` forces the explanation and question; only `confirm_change`
writes it (`#settle`); `submit_form` refuses while one is open.
A yes has to have been **said**: `confirm_change` with `accept:true` must carry a
`quote` found (`grounded()` in `src/user.js`: accents/case/punctuation ignored,
≤1 word in 5 missing) in what the visitor said *after* the proposal was parked —
transcriptions in audio mode, `sendText` in text mode. Otherwise nothing is
written, the model is shown what was actually said, and the question is forced
again. `confirmedWith` records the transcript, not the model's paraphrase. A
session that has received no words at all (hand-driven tests) is not checked. `previous` and
`confirmed` go to evidence only — never the board. `done` and `submit(data, {key})`
carry `key`. Staff `correct()` bypasses all of it.

**The room owns who exists.** The agent starts silent and holds no registrations.
A camera snapshot (`people_detected`) creates them via `agent.roomUpdate()`. The
model cannot create registrations. The realtime session itself only opens on the
first arrival, so an empty lobby costs nothing.

**Half duplex.** The agent never listens while it speaks; a visitor cannot
interrupt. Only room events and finished tools may cut in — via
`conversation.item.truncate` so the model knows what was actually *heard*, then
it resumes the thread.

**Forced turns.** Anything that must be said is issued as `response.create` with
`tool_choice:'none'` — the model then cannot silently skip it. Used for the
read-back before submit, handing over to the next visitor, and interjections.
This took read-back reliability from 4/5 to 5/5.

## Design principles

- **Signals, not gates.** Never reject what a visitor actually said. Every value
  records the quote it came from (`heard` / `inferred` / `prefill` / `corrected`,
  plus `cross` if saved while addressing someone else) and is shown to a human.
  `agent.correct()` lets staff overrule anything without interrupting.
- **Evidence over assertion.** The docs have been wrong repeatedly. Probe the
  live API and measure rates over 10–15 runs before adding machinery.
- **Simplicity is the goal.** The predecessor died of harness. Delete before adding.

## Testing

`npm test` — live text-mode conversations against the real API, plus offline
units. `mode:'text'` runs the whole agent with typed input, which is what makes
end-to-end tests cheap. Existing tests are a regression contract: do not edit
them to fit new code.

What "complete" means comes from the schema, via `fill(form)` in `test/helpers.js`
— never a literal. A hardcoded set of fields is a fixture that goes stale the
day a form grows one, and takes thirty unrelated assertions with it. Tests about
engine machinery run against `withoutClient(form)`, because handover and session
end have no opinion about cameras. Name a field only when the field is the
subject of the test, the way `tool-modes` names `anfitrion` to test `verify`.

## Gotchas

- `session.update` requires `session.type:'realtime'` on **every** update.
- Per-response `instructions` **replace** the session's — the persona must ride
  along or the agent drops character for that turn.
- The same goes for the language block (`languageBlock` in `src/language.js`):
  without it a beat is the turn where the model drifts into English or loses
  its accent. Accent is prompt-steered only; the API has no language parameter.
- All `response.create` calls go through one choke point; two in flight is an error.
  A request made while one is in flight waits in `waiting` *with its instructions* —
  a forced turn that waited as a bare flag used to go out as a plain response.
  A response `#cutOff` abandoned still sends `response.done`; it is marked `cut` and
  does not free the floor.
- A stale `node src/server.js` on port 8787 will answer with old code and look
  like a phantom bug. Check `ps aux` first.
