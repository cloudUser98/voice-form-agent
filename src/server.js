// WebSocket transport. One connection = one conversation.
//
// Binary frames are PCM16 mono 24kHz audio, in both directions.
// Text frames are JSON control/events.
//
//   client -> {type:'start', form, notes?, mode?, debug?, capabilities?}  arms the
//             session. `capabilities` is what this client can be asked for —
//             ['photo','code'] — and a form tool needing anything else is never
//             shown to the model. Leaving it out means everything, so a client
//             that predates this keeps working.
//   client -> {type:'text', text}          typed input instead of speech
//   client -> {type:'correct', registration?, field, value}  human overrules
//   client -> {type:'detected', event}   a raw snapshot, if the client owns the camera
//   client -> {type:'arrive', user?}   somebody is here to fill the form. `user` is
//             their record, checked against the form's user schema; leave it
//             out for a new user. A record that does not fit is refused and
//             nobody is registered.
//   client -> {type:'answer', id, value}   the reply to a server request
//   server -> {type:'request', id, kind, ...}  do something only you can do, and
//             answer with it. The agent waits, with no deadline, until you do.
//   server -> {type:'waiting'}   armed; nobody is in the room yet
//   server -> {type:'refused', key, problems}   a user record did not fit its schema
//   server -> {type:'ended'}     everyone was dealt with; back to waiting
//   server -> {type:'ready'|'transcript'|'state'|'idle'|'speaking'|'flush'|'done'|'error'}
//   server -> {type:'debug', entry}   every event, when start asked for it
//
// `start` only arms the session. The realtime connection is opened by the
// first person the camera reports, so a kiosk facing an empty lobby overnight
// holds no session at all — and once the last person has been registered the
// agent ends, putting the kiosk back in exactly that state. This connection
// outlives any number of agents.
import 'dotenv/config';
import { WebSocketServer, WebSocket } from 'ws';
import { FormAgent } from './agent.js';
import { planFromSnapshot } from './detector.js';
import { availableTools } from './prompt.js';
import { arrival, userSchemaProblems } from './user.js';

const PORT = Number(process.env.PORT || 8787);
const FORMS = new Map();

async function loadForm(name) {
    if (!/^[a-z0-9-]+$/i.test(name)) throw new Error('bad form name'); // NOTE: Do we really need a regex?
    if (!FORMS.has(name)) {
        const mod = await import(new URL(`../forms/${name}.js`, import.meta.url)); // NOTE: Forms are javascript files
        // A broken user schema is the integrator's mistake; it fails the start
        // here instead of in front of somebody.
        const problems = userSchemaProblems(mod.default);
        if (problems.length) throw new Error(`${name}: ${problems.join('; ')}`);
        FORMS.set(name, mod.default);
    }
    return FORMS.get(name);
}

const wss = new WebSocketServer({ port: PORT });
console.log(`voice-form-agent listening on ws://localhost:${PORT}`);

wss.on('connection', (ws) => {
    /** @type {FormAgent} */
    let agent = null;
    let connectionConfig = null;                  // what to build once somebody shows up
    let detector = null;
    // A camera reports the same person every few seconds. A refused record is
    // said once — the same refusal again is not news.
    const refusalsSaid = new Set();
    
    const say = (obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));

    ws.on('message', async (data, isBinary) => {
        // If user audio send it to the agent
        if (isBinary) return agent?.sendAudio(data);

        let msg;
        try {
            msg = JSON.parse(data);
        } catch {
            return say({ type: 'error', error: 'invalid json' });
        }

        if (msg.type === 'start') {
            // NOTE: Check if this validation is correct
            if (connectionConfig) return say({ type: 'error', error: 'already started' });
            try {
                connectionConfig = {
                    form:  await loadForm(msg.form), // .js file
                    name:  msg.form,
                    mode:  msg.mode === 'text' ? 'text' : 'audio',
                    notes: msg.notes || '', // NOTE: Check how this works
                    debug: !!msg.debug,
                    capabilities: Array.isArray(msg.capabilities) ? msg.capabilities : null,
                };
                reportDroppedTools(connectionConfig);
            } catch (err) {
                return say({ type: 'error', error: String(err.message || err) });
            }
            watchDetector();
            return say({ type: 'waiting', form: msg.form });
        }

        // A raw snapshot forwarded by a client that owns the camera itself. Allowed
        // before an agent exists — it is the thing that creates one.
        if (msg.type === 'detected') return anaunceDetection(msg.event);
        if (msg.type === 'arrive') return arrive(msg.user ?? null);

        if (!agent) return say({ type: 'error', error: 'nobody has arrived at reception yet' });
        if (msg.type === 'text') return agent.sendText(msg.text);
        if (msg.type === 'correct') {
            const r = agent.correct(msg.field, msg.value, msg.registration);
            return r.ok || say({ type: 'error', error: r.error });
        }
        if (msg.type === 'answer') return agent.answer(msg.id, msg.value);
        say({ type: 'error', error: `unknown message ${msg.type}` });
    });

    /**
    * Raw detector snapshot in, agent instructions out — and the session itself
    * if this is the first person through the door. An empty room never opens one.
    */
    // NOTE: Ask what is the advantage of declaring this function on websocket connection
    function anaunceDetection(event) {
        console.log("Detection anaunced: ", event);
        // NOTE: Why not validate everything at the start
        if (!connectionConfig) return;
        
        say({ type: 'detected', event }); // NOTE: Sera necesario avisarle al cliente?

        const roomState = planFromSnapshot(
            event,
            connectionConfig.form,
            agent ? agent.registrations : new Map()
        );
        
        for (const person of roomState.arrived.filter((p) => p.refused)) refuse(person.personKey, person.refused);
        roomState.arrived = roomState.arrived.filter((p) => !p.refused);

        if (!roomState.arrived.length) return; // No one in sight

        // NOTE: Isn't it better to build Agent at the start of the connection
        if (!agent) {
            agent = build();
            agent.start();
        }
        // Fires ~400ms before the session is ready; roomUpdate queues it and drains
        // on session.updated.
        agent.roomUpdate(roomState);
    }

    /**
     * Somebody is here, named by the integrator rather than seen by a camera.
     * Checked before anything opens: a refused record costs no session.
     */
    function arrive(user) {
        if (!connectionConfig) return say({ type: 'error', error: 'send start first' });
        const checked = arrival(connectionConfig.form, user);
        if (!checked.ok) return refuse(checked.key ?? null, checked.problems);

        if (!agent) {
            agent = build();
            agent.start();
        }
        const r = agent.arrive(user);
        if (!r.ok) refuse(checked.person.personKey, r.problems);
    }

    function refuse(key, problems) {
        const said = `${key}|${problems.join('|')}`;
        if (refusalsSaid.has(said)) return;
        refusalsSaid.add(said);
        console.log(`refused user ${key}: ${problems.join('; ')}`);
        say({ type: 'refused', key, problems });
    }

    /**
     * Say out loud which tools this client cannot serve.
     *
     * Only the fact, never a verdict. A dropped tool may well be one this form
     * could not complete without — `foto` is filled by a tool and by nothing
     * else — but nothing declares which tool fills which field, so guessing at
     * it here produces a warning that fires when a camera client drops the code
     * reader and everything is fine. One honest line beats a scary wrong one;
     * see TODO.md if the precise check ever earns its keep.
     */
    function reportDroppedTools({ form, name, capabilities }) {
        const kept = availableTools(form, capabilities);
        const dropped = (form.tools || []).filter((t) => !kept.includes(t));
        if (!dropped.length) return;

        const names = dropped.map((t) => `${t.definition.name} (needs ${t.needs})`).join(', ');
        console.log(`${name}: client cannot serve ${names}`);
    }

    function build() {
        const a = new FormAgent({
            form:  connectionConfig.form,
            notes: connectionConfig.notes,
            mode:  connectionConfig.mode,
            capabilities: connectionConfig.capabilities,
        });
        a.on('open', () => say({ type: 'ready', session: a.sessionId, trace: a.trace.file }));
        a.on('audio', (buf) => ws.readyState === ws.OPEN && ws.send(buf, { binary: true }));
        a.on('transcript', (m) => say({ type: 'transcript', ...m }));
        a.on('state', (s) => say({ type: 'state', ...s }));
        a.on('idle', () => say({ type: 'idle' }));
        a.on('speaking', (on) => say({ type: 'speaking', on }));
        a.on('focus', (f) => say({ type: 'focus', ...f }));
        a.on('flush', () => say({ type: 'flush' }));
        a.on('request', (r) => say({ type: 'request', ...r }));
        a.on('done', (d) => say({ type: 'done', ...d }));
        a.on('error', (e) => say({ type: 'error', error: String(e.message || e) }));

        // Everyone was dealt with. Drop the agent and go back to how the kiosk
        // started: armed, holding no session, waiting for the next arrival to
        // build a fresh one. Clearing `agent` first is also what tells the close
        // handler below that this was deliberate.
        a.on('ended', ({ session }) => {
            agent = null;
            say({ type: 'ended', session });
            say({ type: 'waiting', form: connectionConfig.name });
        });

        // A socket that dies while the agent is still the live one is a failure,
        // and the client should hear about it. One that dies after 'ended' is just
        // the agent hanging up, and must not take the kiosk down with it.
        a.on('close', () => { if (agent === a) ws.close(); });
        if (connectionConfig.debug) a.on('debug', (entry) => say({ type: 'debug', entry }));
        
        return a;
    }

    /**
    * The camera service is external and may not be running. Its absence must
    * never take the session down — it just means nobody is announced.
    */
    function watchDetector() {
        const url = process.env.DETECTOR_URL || 'ws://localhost:8765';
        try {
            detector = new WebSocket(url);
            detector.on('message', (raw) => {
                try {
                    anaunceDetection(JSON.parse(raw));
                } catch { /* not ours */ }
            });
            detector.on('error', () => say({ type: 'error', error: `no detector at ${url}` }));
        } catch { /* nothing to watch */ }
    }

    ws.on('close', () => { agent?.close(); detector?.close(); });
});
