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
    src/server.js      WebSocket transport (only file that opens ports)
    src/trace.js       JSONL of every event, per session
    forms/*.js         a form = persona paragraph + JSON Schema + submit()
    forms/api.js       the endpoints a form calls out to. The engine never imports it
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

## Gotchas

- `session.update` requires `session.type:'realtime'` on **every** update.
- Per-response `instructions` **replace** the session's — the persona must ride
  along or the agent drops character for that turn.
- All `response.create` calls go through one choke point; two in flight is an error.
- A stale `node src/server.js` on port 8787 will answer with old code and look
  like a phantom bug. Check `ps aux` first.
