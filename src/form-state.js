import { applyPatch, missingFields, checkField, isEmpty } from './validate.js';

/**
 * One form being filled in, and nothing else.
 *
 * No sockets, no OpenAI, no events, no timers — every method is synchronous and
 * deterministic. This is the piece you can change and test without touching the
 * realtime session, and the piece an agent holds one or many of.
 */
export class FormState {
  constructor(schema, { prefill = {}, label = '' } = {}) {
    this.schema = schema;
    this.label = label;
    this.data = { ...prefill };
    // Where each value came from, so a human can spot one the agent invented.
    // Never used to accept or reject anything — only to show.
    this.evidence = Object.fromEntries(
      Object.keys(prefill).map((k) => [k, { source: 'prefill', heard: null }]),
    );
  }

  /**
   * Record what the agent learned. `quotes` maps a field to the words the
   * visitor actually used; it is display data only and never affects whether a
   * value is accepted. `addressing` names the person the agent was talking to
   * when the value did NOT belong to them.
   */
  save(patch, quotes = {}, { addressing = null } = {}) {
    const { problems, changed } = applyPatch(this.schema, this.data, patch);
    for (const field of changed) {
      const heard = typeof quotes[field] === 'string' ? quotes[field].trim() : '';
      this.evidence[field] = {
        source: heard ? 'heard' : 'inferred',
        heard: heard || null,
        // Saved onto this form while the agent was talking to someone else.
        // Never rejected — shown, so a person can spot a mis-attribution.
        ...(addressing ? { cross: addressing } : {}),
      };
    }
    return { changed, problems };
  }

  /** A human overrules the agent. Passing an empty value clears the field. */
  correct(field, value) {
    const spec = this.schema.properties?.[field];
    if (!spec) return { ok: false, error: `unknown field ${field}` };

    const problems = isEmpty(value) ? [] : checkField(field, spec, value);
    if (problems.length) return { ok: false, error: problems.join('; ') };

    if (isEmpty(value)) {
      delete this.data[field];
      delete this.evidence[field];
    } else {
      this.data[field] = value;
      this.evidence[field] = { source: 'corrected', heard: null };
    }
    return { ok: true };
  }

  missing() { return missingFields(this.schema, this.data); }

  get complete() { return this.missing().length === 0; }

  snapshot() {
    return {
      data: { ...this.data },
      evidence: { ...this.evidence },
      missing: this.missing(),
    };
  }
}
