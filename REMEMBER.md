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
