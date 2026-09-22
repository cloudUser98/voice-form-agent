// Somebody who has visited before, as the integrator's own system knows them.
//
// A user schema is shared: every form a visitor fills imports this one file,
// and each form takes only the fields it has. See src/user.js for the rules.
//
// Not wired into forms/visit.js yet. Doing so changes what the camera prefills
// (today it prefills every key the form knows, `anfitrion` included); with this
// schema only the fields below marked `prefill` are.
export default {
  // Identifies the record in their database. Handed back in `done` and to
  // `submit(data, { key })`; never shown to the model.
  key: 'persona_id',

  properties: {
    persona_id: { type: 'string' },

    // Submitting a different name renames the visitor in their system, so it
    // is asked about first.
    visitante: {
      type: 'string',
      prefill: true,
      confirmOnly: true,
      beforeUpdate: 'Si registras la visita con otro nombre, también se cambiará el nombre en su perfil de visitante.',
    },

    email: {
      type: 'string',
      prefill: true,
      confirmOnly: true,
      beforeUpdate: 'Los avisos de sus visitas empezarán a llegar al correo nuevo.',
    },

    // Free to change: a visitor who comes from somewhere else today just says so.
    procedencia: { type: 'string', prefill: true },

    // Known to the integrator, never prefilled, never shown to the model.
    nivel_acceso: { type: 'string' },
  },
};
