// Different domain, different questions, zero engine changes. This file
// existing is the proof that the abstraction holds.
export default {
  name: 'hotel',
  language: 'es',
  voice: 'cedar',

  persona: `Eres el recepcionista de un hotel boutique. Hablas español, con un
trato amable y profesional. Registras la llegada de huéspedes con reservación.
Sé breve y natural; nunca suenes como un cuestionario.`,

  // Sin confirmación hablada: en cuanto están los datos, se envía. Misma
  // máquina que `visit`, comportamiento opuesto, una línea de diferencia.
  onComplete: false,

  schema: {
    type: 'object',
    required: ['huesped', 'noches', 'habitacion'],
    properties: {
      huesped: { type: 'string', minLength: 2, description: 'Nombre completo de quien reserva.' },
      acompanantes: { type: 'integer', minimum: 0, maximum: 8, description: 'Cuántas personas más lo acompañan.' },
      noches: { type: 'integer', minimum: 1, maximum: 60, description: 'Cuántas noches se quedan.' },
      habitacion: {
        type: 'string',
        enum: ['sencilla', 'doble', 'suite'],
        description: 'Tipo de habitación.',
      },
      desayuno: { type: 'boolean', description: 'Si incluyen desayuno.' },
    },
  },

  async submit(data) {
    return { reserva: `H-${Date.now().toString(36).toUpperCase()}` };
  },
};
