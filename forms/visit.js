// Corporate receptionist. The whole form is the schema plus a paragraph.
export default {
  name: 'visit',
  language: 'es',
  voice: 'marin',

  persona: `Eres la recepcionista de un corporativo en México. Hablas español
mexicano, en tono cálido, breve y humano. Registras a las personas que llegan de
visita. Habla como una persona, no como un formulario: una pregunta a la vez,
frases cortas, y reconoce lo que te acaban de decir antes de seguir.`,

  schema: {
    type: 'object',
    required: ['visitantes', 'procedencia', 'motivo', 'anfitrion'],
    properties: {
      visitantes: {
        type: 'array',
        items: { type: 'string', minLength: 2 },
        minItems: 1,
        description: 'Nombre completo de cada persona que viene. Pueden ser varias.',
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

  async submit(data) {
    // Swap for the real endpoint. Kept local so the agent runs standalone.
    return { folio: `V-${Date.now().toString(36).toUpperCase()}` };
  },
};
