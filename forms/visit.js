import { blocking } from '../src/tools.js';
import { getAppointment, getHosts, registerVisit } from './api.js';

// Every failure is a refusal — not in the directory, endpoint down, timeout,
// bad payload, all of it. The visitor is asked for the name again either way;
// only the wording differs, and the model reads these to decide what to say.
async function lookupHost(name) {
    try {
        return (await getHosts(name))
        ? { ok: true }
        : { ok: false, error: 'No aparece nadie con ese nombre en el directorio.' };
    } catch {
        return { ok: false, error: 'El directorio no responde; no se puede confirmar ahora mismo.' };
    }
}

// The kiosk read a code; this turns it into a visit. Same shape as lookupHost
// and for the same reason: every failure is one refusal — unknown code, endpoint
// down, timeout, nonsense back — and only the wording differs.
//
// Only the keys this schema knows become fields. Whatever else their system
// sends about the appointment is theirs and is dropped here, the same split
// detector.js#toPerson makes with what the camera reports.
const FROM_APPOINTMENT = ['visitante', 'procedencia', 'motivo', 'anfitrion'];

async function lookupAppointment(code) {
    try {
        const cita = await getAppointment(code);
        if (!cita) return { ok: false, error: 'Ese código no corresponde a ninguna cita.' };

        const fields = Object.fromEntries(
            FROM_APPOINTMENT
                .map((field) => [field, cita[field]])
                .filter(([, value]) => typeof value === 'string' && value.trim()),
        );

        return Object.keys(fields).length
            ? { ok: true, fields }
            : { ok: false, error: 'La cita no trae datos para el registro.' };
    } catch {
        return { ok: false, error: 'No se pudo consultar la cita ahora mismo.' };
    }
}

async function saveVisit(data) {
    console.log("saveVisit param: ", data);
    
    try {
        return (await registerVisit(data))
        ? { ok: true }
        : { ok: false, error: 'No se pudo registrar la visita.' };
    } catch {
        return { ok: false, error: 'No se pudo registrar la visita.' };
    }
}

// The kiosk owns the camera, so the photo is the client's to produce and
// nobody else's. The tool asks for one and hands back whatever arrives without
// ever looking at it — the engine turns it into a token and keeps the bytes
// out of the model's sight.
//
// It waits for as long as it takes. Somebody still walking up to the camera is
// not a failure, and there is nothing sensible to do with a refusal anyway:
// `foto` is required, so a photo is the only way past it.
const takePhoto = {
    needs: 'photo',
    definition: {
        type: 'function',
        name: 'take_photo',
        description: 'Toma la fotografía de UNA persona con la cámara. Es la única forma de llenar `foto`.',
        parameters: {
            type: 'object',
            properties: {
                registration: {
                    type: 'string',
                    description: 'De quién es la foto, p. ej. "r1". Léelo del tablero.',
                },
            },
            required: ['registration'],
        },
    },

    run: blocking(async ({ registration }, { ask }) => ({
        ok: true,
        attach: { foto: await ask('photo', { registration }) },
    }), {
        say: 'Diles en UNA frase que vas a tomarles una foto, que miren a la cámara y esperen un momento.',
        timeoutMs: Infinity,
    }),
};

// The visitor's own system gives them a code for the visit. The kiosk reads it;
// this tool asks for it, and what comes back is a string and nothing more —
// their system's opaque token. The visit behind it is fetched here, from them.
//
// That split is deliberate. A code carrying the visit itself would make the
// kiosk an authority on who is coming to see whom, and a printer enough to
// forge one. A code that stands for a visit can be revoked and expired, and a
// host printed on it is still checked against the directory, because `fields`
// travels the same road a spoken value travels.
//
// Nothing here knows what a QR is — `code` is a word the kiosk understands. And
// nothing here is in a hurry: like the camera, it waits. Somebody rummaging in
// a bag for a piece of paper is not a failure, and giving up belongs to the
// kiosk, which is the only thing that knows its reader stopped responding.
//
// `opening` puts the question first, because a code answered at the door saves
// four questions and a code answered at the end saves none. Declining is a real
// answer — skip_step — and it is not the end of it: `codigo` stays on the board
// as an empty optional field and the tool stays callable, so somebody who finds
// their code three questions later still gets to use it. That is the whole
// difference from the first attempt, which put the same question behind a
// twenty-second deadline and spent it on whoever was slowest.
const scanCode = {
    needs: 'code',
    opening: 'Pregúntales en UNA frase si traen su código de cita; si no lo traen '
        + 'o prefieren no usarlo, no pasa nada.',
    definition: {
        type: 'function',
        name: 'scan_code',
        description: 'Lee con el lector del kiosco el código de cita que trae el visitante y rellena '
            + 'lo que la cita traiga. Es la única forma de llenar `codigo`. Úsalo en cuanto digan que '
            + 'traen uno, y en cualquier momento del registro: al principio, o más tarde si tardan en '
            + 'encontrarlo o cambian de opinión.',
        parameters: {
            type: 'object',
            properties: {
                registration: {
                    type: 'string',
                    description: 'De quién es el código, p. ej. "r1". Léelo del tablero.',
                },
            },
            required: ['registration'],
        },
    },

    run: blocking(async ({ registration }, { ask }) => {
        const code = String((await ask('code', { registration })) ?? '').trim();
        // The reader gave up, or there was nothing to read. Say so plainly: the
        // agent apologises in one sentence, carries on asking out loud, and the
        // tool is still there when they find it.
        if (!code) return { ok: false, error: 'El lector no devolvió ningún código.' };

        const cita = await lookupAppointment(code);
        if (!cita.ok) return cita;

        return { ok: true, fields: { codigo: code, ...cita.fields } };
    }, {
        say: 'Pídeles en UNA frase que acerquen su código al lector y esperen un momento.',
        timeoutMs: Infinity,
    }),
};

// Corporate receptionist. The whole form is the schema plus a paragraph.
export default {
    name: 'visit',
    language: 'es-MX',
    voice: 'marin',

    persona: `Eres la recepcionista de un corporativo en México. Hablas español
    mexicano, en tono cálido, breve y humano. Registras a las personas que llegan de
    visita. Habla como una persona, no como un formulario: una pregunta a la vez,
    frases cortas, y reconoce lo que te acaban de decir antes de seguir.`,

    // Un registro es una persona. Antes de enviarlo, repite los datos y espera
    // confirmación. Pon `false` y se envía sin confirmar.
    onComplete: 'read-back',

    // Qué campo pone nombre al registro en el tablero.
    labelFrom: 'visitante',

    schema: {
        type: 'object',
        properties: {
            visitante: {
                type: 'string',
                minLength: 2,
                maxLength: 120,
                description: 'Nombre completo del visitante.',
            },
            procedencia: {
                type: 'string',
                minLength: 2,
                maxLength: 120,
                description: 'Empresa u organización de la que vienen, o "visita personal".',
            },
            motivo: {
                type: 'string',
                minLength: 2,
                maxLength: 240,
                description: 'A qué vienen, en pocas palabras.',
            },
            // The only field whose value is not ours to accept: the person has to
            // exist in the directory. `verify` runs inside save_fields, so a name
            // that is not there never lands in the form — the visitor is simply
            // asked again. Functions do not survive JSON, so this never reaches the
            // model as part of the schema.
            anfitrion: {
                type: 'string',
                minLength: 2,
                maxLength: 120,
                description: 'Nombre de la persona a la que visitan.',
                verify: blocking(lookupHost, {
                    say: (name) => `Di en UNA frase que estás viendo si ${name} puede recibirlos, y que esperen un momento.`,
                    timeoutMs: 6000,
                }),
            },
            // The code the visitor brings, if they bring one. Not required —
            // plenty of people turn up without one — but it is a field like any
            // other, so the board carries it and the model can see it is still
            // empty. Only scan_code fills it: a code that arrived any other way
            // was never exchanged for a visit, so it stands for nothing.
            codigo: {
                type: 'string',
                minLength: 1,
                maxLength: 64,
                description: 'Código de la cita que trae el visitante. Lo lee el lector con scan_code. '
                    + 'Nunca lo pidas de palabra, nunca lo guardes tú y nunca te lo inventes.',
            },
            // `client` means nobody in this conversation can fill it — not the
            // visitor, who cannot say a photograph out loud, and not the agent,
            // which is kept out of the tool's schema so it cannot try. It sits
            // on the board as missing until take_photo puts something there.
            foto: {
                type: 'string',
                client: true,
                description: 'Fotografía del visitante. La toma la cámara con take_photo; nunca la pidas de palabra ni te la inventes.',
            },
        },
        required: [
            'visitante',
            'procedencia',
            'motivo',
            'anfitrion',
            'foto'
        ]
    },

    tools: [scanCode, takePhoto],

    // `blocking`: the visitor waits for their folio rather than wandering off
    // mid-save. Swap the body for the real endpoint — the decorator already
    // covers the wait, and a local call this fast never triggers the filler.
    // submit: blocking(async (data) => ({ folio: `V-${Date.now().toString(36).toUpperCase()}` }), {
    //     say: 'Dile en UNA frase que estás guardando el registro y que espere un momento.',
    // }),
    submit: blocking(async (data) => saveVisit(data), {
        say: 'Dile en UNA frase que estás guardando el registro y que espere un momento.',
    }),
};
