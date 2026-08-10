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

  const lines = entries.map(({ id, label, state, status, result, focused }) => {
    const head = `${focused ? '▶ ' : '  '}${[id, label || '(unnamed)'].filter(Boolean).join(' ')}`;
    const filled = Object.entries(state.data)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(', ') || '(nothing yet)';
    const missing = state.missing();

    let tail;
    if (status === 'submitted') {
      // Status only. What to do next depends on the WHOLE board, not on one
      // row — a row saying "say goodbye and stop" is what stranded the people
      // still waiting.
      tail = `   SUBMITTED${result?.folio ? ` (${result.folio})` : ''}`;
    } else if (status === 'closed') {
      tail = '   CLOSED';
    } else if (missing.length) {
      tail = `   missing: ${missing.join(', ')}`;
    } else {
      tail = `   COMPLETE ▸ NEXT: ${nextAction(form, { label, state })}`;
    }

    return `${head}\n   filled: ${filled}\n${tail}`;
  });

  return `=== OPEN FORMS ===\n${lines.join('\n')}${sharedGaps(entries)}${whatNext(entries)}`;
}

/**
 * One instruction for the whole board, so it can see who is still waiting. A
 * per-row instruction cannot: that is how a finished registration ended up
 * telling the agent to stop while somebody stood there unserved.
 */
function whatNext(entries) {
  if (!entries.some((e) => e.status !== 'open')) return '';   // nothing has ended yet
  const open = entries.filter((e) => e.status === 'open');

  return open.length
    ? `\n\n  ${open[0].id} (${open[0].label || 'the unidentified visitor'}) is still waiting `
      + 'and has NOT been registered.'
    // The goodbye is a forced beat (agent.js #farewellBeat), not a board line —
    // asking for it here too is how the last visitor gets told goodbye twice.
    : '\n\n  Everyone has been dealt with. Say nothing further, ask nothing '
      + 'and call no tool.';
}

/**
 * Fields that every open registration is still missing. Pure computation, but
 * it is what lets the agent notice it can ask one question for the whole room
 * instead of working through people one at a time.
 */
function sharedGaps(entries) {
  const open = entries.filter((e) => e.status === 'open');
  if (open.length < 2) return '';

  const sets = open.map((e) => new Set(e.state.missing()));
  const shared = [...sets[0]].filter((f) => sets.every((s) => s.has(f)));
  if (!shared.length) return '';

  const who = open.map((e) => e.id).join(' and ');
  return `\n\n  ${who} ALL still need: ${shared.join(', ')}`
       + '\n  → you may ask the group once instead of repeating yourself.';
}

export function buildInstructions(form, { notes, entries = [] } = {}) {
    const { properties = {}, required = [] } = form.schema;
    const fields = Object.entries(properties)
        .map(([name, spec]) => describe(name, spec, required.includes(name)))
        .join('\n');

    let instructions = [
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
        '- Registrations appear on the board when someone walks in and you are told about it. You never create them yourself.',
        '- A registration with no name yet is somebody the camera did not recognise. Refer to them naturally — the other visitor, the person with them — until they tell you their name.',
        '- You decide who to ask what, and in what order — whatever keeps the conversation short and natural. Call focus when you turn your attention to a different person, so everyone can see who you are addressing.',
        '- When several people are missing the SAME field, ask the group once instead of repeating yourself, then save the answer to each registration it applies to with a separate save_fields call.',
        '- If an answer could belong to more than one person, ask who it was for before saving it. But if you just addressed someone by name, the answer is theirs — do not ask.',
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
    console.log("buildInstructions Output:");
    console.log(instructions);

    return instructions;
}

export function buildTools(form) {
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

    const focus = {
        type: 'function',
        name: 'focus',
        description: 'Say who you are now talking to. Call it whenever you turn your attention to a different person.',
        parameters: {
            type: 'object',
            properties: { registration: { type: 'string', description: 'The registration of the person you are addressing.' } },
            required: ['registration'],
        },
    };

    return [focus, save, submit, list, close, ...(form.tools || []).map((t) => t.definition)];
}
