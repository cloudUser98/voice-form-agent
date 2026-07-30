// Minimal JSON Schema validation — the subset a spoken form actually uses.
// Runs in memory against the session's own state; no network, no dependencies.

export function isEmpty(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

export function missingFields(schema, data) {
  return (schema.required || []).filter((k) => isEmpty(data[k]));
}

// Returns an array of human-readable problems; empty means valid.
export function checkField(name, spec, value) {
  const bad = (msg) => [`${name}: ${msg}`];
  const t = spec.type;

  if (t === 'array') {
    if (!Array.isArray(value)) return bad('expected a list');
    if (spec.minItems && value.length < spec.minItems) return bad(`needs at least ${spec.minItems} item(s)`);
    const itemSpec = spec.items || {};
    return value.flatMap((v, i) => checkField(`${name}[${i}]`, itemSpec, v));
  }
  if (t === 'integer' || t === 'number') {
    if (typeof value !== 'number' || Number.isNaN(value)) return bad('expected a number');
    if (t === 'integer' && !Number.isInteger(value)) return bad('expected a whole number');
    if (spec.minimum !== undefined && value < spec.minimum) return bad(`must be at least ${spec.minimum}`);
    if (spec.maximum !== undefined && value > spec.maximum) return bad(`must be at most ${spec.maximum}`);
    return [];
  }
  if (t === 'boolean') return typeof value === 'boolean' ? [] : bad('expected true or false');

  // string (and anything unspecified)
  if (typeof value !== 'string') return bad('expected text');
  if (spec.enum && !spec.enum.includes(value)) return bad(`must be one of: ${spec.enum.join(', ')}`);
  if (spec.minLength && value.trim().length < spec.minLength) return bad(`too short`);
  if (spec.maxLength && value.length > spec.maxLength) return bad(`too long`);
  if (spec.pattern && !new RegExp(spec.pattern).test(value)) return bad('wrong format');
  return [];
}

// Splits an incoming patch into what we accept and what we reject with reasons.
export function applyPatch(schema, data, patch) {
  const accepted = {};
  const problems = [];

  for (const [name, value] of Object.entries(patch || {})) {
    const spec = schema.properties?.[name];
    if (!spec) { problems.push(`${name}: not a field of this form`); continue; }
    if (isEmpty(value)) continue;                     // silently ignore blanks
    const errs = checkField(name, spec, value);
    if (errs.length) problems.push(...errs);
    else accepted[name] = value;
  }

  return { accepted: Object.assign(data, accepted), problems, changed: Object.keys(accepted) };
}
