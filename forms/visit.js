import { blocking } from '../src/tools.js';

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
      anfitrion: {
        type: 'string',
        minLength: 2,
        maxLength: 120,
        description: 'Nombre de la persona a la que visitan.',
      },
    },
  },

  // `blocking`: the visitor waits for their folio rather than wandering off
  // mid-save. Swap the body for the real endpoint — the decorator already
  // covers the wait, and a local call this fast never triggers the filler.
  submit: blocking(async (data) => ({ folio: `V-${Date.now().toString(36).toUpperCase()}` }), {
    say: 'Dile en UNA frase que estás guardando el registro y que espere un momento.',
  }),
};
