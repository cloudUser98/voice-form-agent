// Turns a form definition into session instructions.
//
// Two channels, deliberately separated:
//   - the BOARD (here) carries current state and what to do next. It is
//     rebuilt and pushed with session.update whenever anything changes, so
//     there is exactly one copy and it is never stale.
//   - tool results (in agent.js) carry facts about an action that just
//     happened. They report; they do not instruct.

const describe = (name, spec, required) => {
  const bits = [spec.type];
  if (spec.enum) bits.push(`one of: ${spec.enum.join(', ')}`);
  if (required) bits.push('required');
  return `- ${name} (${bits.join('; ')})${spec.description ? ` — ${spec.description}` : ''}`;
};

/**
 * What the agent should do once every required field is filled. Driven purely
 * by the form's `onComplete`, so the same engine reads a record back for one
 * form and submits silently for another.
 */
export function nextAction(form, { label, state }) {
  const rule = form.onComplete;

  if (rule === undefined || rule === null || rule === false) {
    return 'Call submit_form now.';
  }
  if (rule === 'read-back') {
    const who = label ? ` to ${label}` : '';
    return `The form is complete but NOT yet submitted. Repeat the recorded details back${who} in ONE natural sentence and ask them to confirm. `
         + `Only after they confirm, call submit_form. If you already asked and they confirmed, call submit_form now.`;
  }
  if (typeof rule === 'function') {
    return String(rule(state.data, { label }) || '').trim();
  }
  return String(rule).trim();
}

/** The live status block. One entry today, many once the agent runs several. */
export function buildBoard(form, entries) {
  if (!entries.length) return '=== OPEN FORMS ===\n(none yet)';

  const lines = entries.map(({ id, label, state, status, result }) => {
    const head = [id, label || '(unnamed)'].filter(Boolean).join(' ');
    const filled = Object.entries(state.data)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(', ') || '(nothing yet)';
    const missing = state.missing();

    let tail;
    if (status === 'submitted') {
      // Without this the agent keeps making conversation after the folio is
      // issued, because the board still reads as work outstanding.
      tail = `   SUBMITTED${result?.folio ? ` (${result.folio})` : ''} ▸ NEXT: say goodbye in ONE short sentence. `
           + `Do not ask for anything else and do not call any tool.`;
    } else if (missing.length) {
      tail = `   missing: ${missing.join(', ')}`;
    } else {
      tail = `   COMPLETE ▸ NEXT: ${nextAction(form, { label, state })}`;
    }

    return `${head}\n   filled: ${filled}\n${tail}`;
  });

  return `=== OPEN FORMS ===\n${lines.join('\n')}`;
}

export function buildInstructions(form, { notes, entries = [] } = {}) {
  const { properties = {}, required = [] } = form.schema;
  const fields = Object.entries(properties)
    .map(([name, spec]) => describe(name, spec, required.includes(name)))
    .join('\n');

  return [
    form.persona.trim(),
    '',
    'You are collecting the following information through natural conversation:',
    fields,
    '',
    'How to work:',
    '- Call save_fields the moment you learn something, even partially. You may save several fields at once.',
    '- Ask for whatever the status block below says is missing, one thing at a time, in your own words.',
    '- You may have SEVERAL registrations open at once, one per person. Every save_fields, submit_form and close_registration needs its `registration` id — read it off the status block below. If you lose track of who is who, call open_registrations.',
    '- Address a person by name before asking them something, so everyone knows who you are talking to.',
    '- An answer belongs to the person you last addressed, unless the speaker says who they are.',
    '- Work on ONE registration at a time. If someone new arrives, greet them warmly straight away and call start_registration so they appear on the board — but do not ask them questions until the registration in progress is submitted or closed.',
    '- If someone corrects themselves, call save_fields again with the new value. It replaces the old one.',
    '- For list fields, always send the complete list, not just the new entry.',
    '- Never invent a value. If you did not hear it clearly, ask.',
    '- With save_fields, fill in `quotes` with the words the visitor actually said for each field. Nobody checks this against you and no value is ever rejected because of it — a person reads it to catch mistakes. So report it honestly: if you worked a value out rather than hearing it, leave that field out of `quotes`.',
    '- A staff member may correct a field behind the scenes. If that happens, accept the new value silently and carry on; never announce it.',
    '- Never read field names or technical errors out loud. You are having a conversation, not filling a spreadsheet.',
    notes ? `\nContext about who is in front of you:\n${notes}` : '',
    '',
    'The block below is rewritten as things change. Trust it over your memory:',
    buildBoard(form, entries),
  ].filter(Boolean).join('\n');
}

export function buildTools(form) {
  const start = {
    type: 'function',
    name: 'start_registration',
    description: 'Open a new registration for a DIFFERENT person who has just arrived. Never call this for someone who already has one.',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'The name of the person this registration is for, if you already know it. Leave it out if you do not.' },
      },
      required: [],
    },
  };

  const save = {
    type: 'function',
    name: 'save_fields',
    description: 'Record what you have learned about ONE person. Send only the fields you are sure about.',
    parameters: {
      type: 'object',
      properties: {
        registration: { type: 'string', description: 'Which registration this belongs to, e.g. "r1". Read it off the status block.' },
        fields: {
          type: 'object',
          description: 'The values you learned for that person.',
          properties: form.schema.properties,
        },
        // Display-only. Never validated, never used to reject a value — it is
        // shown to a human so they can spot a value nobody actually said.
        quotes: {
          type: 'object',
          description: 'For each field you are saving, the words the person actually used. Omit a field here if you inferred it rather than heard it.',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['registration', 'fields'],
    },
  };

  const submit = {
    type: 'function',
    name: 'submit_form',
    description: "Finalise and submit ONE person's form. Only works once every required field of that registration is filled.",
    parameters: {
      type: 'object',
      properties: { registration: { type: 'string', description: 'Which registration to submit, e.g. "r1".' } },
      required: ['registration'],
    },
  };

  const list = {
    type: 'function',
    name: 'open_registrations',
    description: 'List every registration, who it is for and what it still needs. Use it whenever you are unsure which id belongs to whom.',
    parameters: { type: 'object', properties: {}, required: [] },
  };

  const close = {
    type: 'function',
    name: 'close_registration',
    description: 'Abandon a registration that will not be finished — for example the person left and said they would come back later.',
    parameters: {
      type: 'object',
      properties: {
        registration: { type: 'string', description: 'Which registration to abandon.' },
        reason: { type: 'string', description: 'Short reason, for the record.' },
      },
      required: ['registration'],
    },
  };

  return [start, save, submit, list, close, ...(form.tools || []).map((t) => t.definition)];
}
