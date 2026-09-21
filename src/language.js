// The language the agent speaks, and the accent it speaks it with.
//
// The Realtime API has no output-language or accent parameter: the voice is
// steered by the instructions alone. So a language here is two things — a
// block of prompt that locks the model into it, and the code the transcriber
// expects for what the visitor says.

export const DEFAULT_LOCALE = 'en-US';

// Accents the model is known to take well. Anything else falls back to "a
// natural native accent from <region>", which works for any locale Intl knows.
const ACCENTS = {
    'en-US': 'a natural General American accent',
    'en-GB': 'a natural British accent (Received Pronunciation)',
    'es-MX': 'a natural Mexican accent, as spoken in Mexico City',
    'es-ES': 'a natural Castilian Spanish accent, as spoken in Madrid',
    'pt-BR': 'a natural Brazilian accent, as spoken in São Paulo',
    'fr-FR': 'a natural Parisian French accent',
    'fr-CA': 'a natural Québécois accent',
};

// The only regional codes the transcriber accepts; every other locale is sent
// as its bare language (`es-MX` is rejected, `es` is not).
const REGIONAL_TRANSCRIPTION = new Set(['zh-cn', 'zh-tw', 'zh-hk']);

/**
 * `input` is a BCP-47 tag ('es-MX', or a bare 'es') or `{ locale, accent?, name? }`.
 * Returns `{ locale, name, accent, transcription }`.
 */
export function resolveLanguage(input) {
    const spec = typeof input === 'string' ? { locale: input } : { ...input };
    let locale;
    try {
        [locale] = Intl.getCanonicalLocales(spec.locale || DEFAULT_LOCALE);
    } catch {
        throw new Error(`invalid language "${spec.locale}": expected a BCP-47 tag such as "es-MX"`);
    }

    const { language, region } = new Intl.Locale(locale);
    const name = spec.name || new Intl.DisplayNames(['en'], { type: 'language' }).of(locale);
    const regionName = region && new Intl.DisplayNames(['en'], { type: 'region' }).of(region);
    const accent = spec.accent
        || ACCENTS[locale]
        || (regionName ? `a natural native accent from ${regionName}` : 'a natural native accent');
    const transcription = REGIONAL_TRANSCRIPTION.has(locale.toLowerCase()) ? locale.toLowerCase() : language;

    return { locale, name, accent, transcription };
}

/**
 * The prompt section that keeps the model in one language. It has to travel
 * with every response — per-response instructions REPLACE the session's.
 */
export function languageBlock({ locale, name, accent }) {
    return [
        '# Language & accent',
        `- Speak ONLY ${name} (${locale}), with ${accent}. EVERY word you say — greetings, questions, read-backs, apologies, short fillers — is in ${name}.`,
        '- These instructions are written in English only for convenience. That is NOT a reason to speak English.',
        `- If someone speaks to you in another language, keep replying in ${name}.`,
        `- If the audio is unintelligible, ask them to repeat — in ${name}.`,
        `- Say names, numbers, dates, times and phone numbers the way a native ${name} speaker would.`,
    ].join('\n');
}

/**
 * `audio.input.transcription` for the chosen model. gpt-live-transcribe takes a
 * `languages` array, the others a single `language` — never both. The prompt
 * primes the transcriber for the accent.
 */
export function transcriptionConfig(model, lang) {
    const prompt = `Conversation in ${lang.name} (${lang.locale}).`;
    if (model === 'gpt-live-transcribe') return { model, prompt, languages: [lang.transcription] };
    return { model, prompt, language: lang.transcription };
}
