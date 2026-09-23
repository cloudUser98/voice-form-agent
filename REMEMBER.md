# Remember

Things that cost time to work out once. Read before re-litigating them.

## There is no "the visitor finished hearing it" event

`response.output_audio.done` and `response.done` mean the server finished
*generating*. Generation outruns playback, so closing a socket on either one
clips the last words off the sentence.

The event that does track playback, `output_audio_buffer.stopped`, exists only
on **WebRTC and SIP**. We are on a raw WebSocket, so it is not available to us
and never will be without changing transport.

What we do instead (`agent.js` `#finish`): count the audio bytes we streamed for
a response and wait out their real duration — `bytes / (24000*2) * 1000` ms,
the same arithmetic `#cutOff` uses. Free, exact, and zero in text mode, which
is what makes session teardown testable offline.

## We are not moving to WebRTC

Checked in August 2026. OpenAI's own rule: WebRTC for *"browser and mobile
clients that capture or play audio directly"*, WebSocket for *"when your server
already receives raw audio from a media pipeline, call system, or worker"*. The
second one is this project.

The leg between us and OpenAI is datacenter-to-datacenter — there is no bad
last mile for WebRTC to protect. And getting its real benefit means connecting
the *browser* straight to OpenAI, which would move the session into the browser.
The session **is** the agent: board, tools, truncate math, half-duplex gating,
registrations, traces, and `mode:'text'` — none of which survive the move, and
the last one is the whole test strategy.

The kiosk leg (server → browser) is a separate question and could go WebRTC on
its own someday. It touches only `server.js` and `clients/`, never `agent.js`.

## The board describes, a beat compels

If something *must* be said, it is a `response.create` with
`tool_choice:'none'` and the persona riding along in `instructions` — see
`#beat`. Asking for it in the board instead means the model can answer by
reaching for a tool and the sentence never happens. This is why read-back went
4/5 → 5/5, and why the goodbye is a beat and not a board line.

Corollary: never ask for the same sentence in both places, or it gets said
twice. When `#farewellBeat` took over the goodbye, `whatNext()` in `prompt.js`
had to stop asking for one.

## Per-response `instructions` REPLACE the session's

They do not merge. Any beat that forgets to prepend `form.persona` drops
character for exactly the sentence you cared most about.

## A blocking tool's wait does not end when its function returns

`#call` holds the floor for the decorated function and nothing else. A tool that
comes back with `fields` is not finished at that point: every field it filled
still has to go through `#verify`, and a `verify` can be a blocking tool of its
own — `anfitrion` is. Left alone, the floor is released in between. The
microphone reopens for the gap, and a client watching `busy` sees the agent go
free and busy again for what the visitor experiences as one single wait.

So the custom-tool branch of `#runTool` wraps the call AND the absorb in
`#holdFloor`. That is also why `busy` is a depth counter rather than a flag:
the inner checks nest inside the outer hold, and only the outermost one emits.

Related: `scan_code` finishing does not mean the form is filled. It means the
values are on their way through the same road a spoken value travels, and one
of them may still be refused by the directory.

## A live measurement that splits replies on newlines is measuring the script

The model often puts its question after a blank line: `"...en tu perfil. \n\n¿Quieres
que hagamos el cambio?"`. A shell pipeline that reads one line per reply sees the
explanation and loses the question. That produced a confident "asks only 8/12", then
"4/15" after a prompt "fix" — both false; the true rate was 15/15 with the original
prompt. Before changing a prompt to fix a measured rate, open the trace
(`response.done` → `output[].content[].text`) for one failing run and check the
failure is really in the model. Print replies one per line with newlines replaced.

## A cover sentence is late by construction

`response.create` → first audio delta is 0.7 s at p50 and 1.2 s at p90 (kiosk
traces, September 2026). A cover requested 400 ms into a tool that takes 0.5–1.4 s
comes out *after* the tool is done: "espera un momento" after the save, "acerca
tu código" after it was read. Two things fix it, and neither is a bigger
`coverAfterMs`:

- the delay counts from **silence** — the end of what the visitor is still
  hearing — not from the call (`#stillPlayingMs`, same arithmetic as `#finish`);
- a cover the tool outruns is **withdrawn** (`#withdraw`): dropped if still
  waiting, `response.cancel {response_id}` if sent but silent, its items deleted.
  Once audio has started it plays out. `response_cancel_not_active` is expected
  noise from that race and is swallowed.
