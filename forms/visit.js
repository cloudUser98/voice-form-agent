import { blocking } from '../src/tools.js';
import { getHosts, registerVisit } from './api.js';

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

// Corporate receptionist. The whole form is the schema plus a paragraph.
export default {
    name: 'visit',
    language: 'es',
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
        required: ['visitante', 'procedencia', 'motivo', 'anfitrion'],
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
        },
    },

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
