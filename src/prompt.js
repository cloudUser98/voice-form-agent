// Turns a form definition into session instructions. The whole "what to ask
// next" logic lives in the tool results, not here — these instructions are
// static for the life of a session.

const describe = (name, spec, required) => {
  const bits = [spec.type];
  if (spec.enum) bits.push(`one of: ${spec.enum.join(', ')}`);
  if (required) bits.push('required');
  return `- ${name} (${bits.join('; ')})${spec.description ? ` — ${spec.description}` : ''}`;
};

export function buildInstructions(form, { notes, data } = {}) {
  const { properties = {}, required = [] } = form.schema;
  const fields = Object.entries(properties)
    .map(([name, spec]) => describe(name, spec, required.includes(name)))
    .join('\n');

  const known = Object.entries(data || {}).filter(([, v]) => v !== undefined && v !== '');

  return [
    form.persona.trim(),
    '',
    'You are collecting the following information through natural conversation:',
    fields,
    '',
    'How to work:',
    '- Call save_fields the moment you learn something, even partially. You may save several fields at once.',
    '- save_fields tells you what is still missing. Ask for that, one thing at a time, in your own words.',
    '- If someone corrects themselves, call save_fields again with the new value. It replaces the old one.',
    '- For list fields, always send the complete list, not just the new entry.',
    '- Call submit_form once nothing is missing.',
    '- Never invent a value. If you did not hear it clearly, ask.',
    '- Never read field names or technical errors out loud. You are having a conversation, not filling a spreadsheet.',
    known.length ? `\nAlready known before the conversation started:\n${known.map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`).join('\n')}` : '',
    notes ? `\nContext about who is in front of you:\n${notes}` : '',
  ].filter(Boolean).join('\n');
}

export function buildTools(form) {
  const save = {
    type: 'function',
    name: 'save_fields',
    description: 'Record what you have learned. Send only the fields you are sure about. Returns what is still missing.',
    parameters: {
      type: 'object',
      properties: form.schema.properties,
      required: [],          // every field optional: partial saves are the norm
    },
  };

  const submit = {
    type: 'function',
    name: 'submit_form',
    description: 'Finalise and submit the form. Only works once every required field is filled.',
    parameters: { type: 'object', properties: {}, required: [] },
  };

  return [save, submit, ...(form.tools || []).map((t) => t.definition)];
}
