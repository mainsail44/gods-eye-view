// The model reads the question before anything is retrieved.
//
// It is asked for a small JSON object — what place, what kind of record,
// which operator, what intent — through the OpenAI-compatible endpoint's
// `response_format` with a JSON schema, which Ollama, vLLM and llama.cpp all
// honour. The model is never asked for coordinates: it names the place and
// the gazetteer places it. A runtime that cannot follow the schema, or a
// reading that fails validation, falls back to an empty reading and the
// service answers the way it did before the reader existed.

export const ENTITY_TYPES = Object.freeze(['datacenter', 'landing-point', 'any']);
export const INTENTS = Object.freeze([
  'list_in_place',
  'nearest_to',
  'operator',
  'count',
  'other',
]);

/** The schema the model fills in. Names are the fields retrieval consumes. */
export const READING_SCHEMA = Object.freeze({
  name: 'question_reading',
  schema: {
    type: 'object',
    properties: {
      place: { type: 'string' },
      region: { type: 'string' },
      country: { type: 'string' },
      entity_type: { type: 'string', enum: [...ENTITY_TYPES] },
      operator: { type: 'string' },
      intent: { type: 'string', enum: [...INTENTS] },
      radius_km: { type: 'number' },
    },
    required: [
      'place',
      'region',
      'country',
      'entity_type',
      'operator',
      'intent',
      'radius_km',
    ],
  },
});

export const READER_PROMPT = [
  'You read one question about local infrastructure records — datacenters and submarine cable landing points — and extract its target as JSON.',
  'place: the most specific locality the question names (a city, town or campus), or an empty string.',
  'region: the state, province or land named or clearly implied, or an empty string.',
  'country: the country named or clearly implied, or an empty string.',
  'entity_type: "datacenter" or "landing-point" when the question asks for one kind, otherwise "any".',
  'operator: a company or organisation the question names, or an empty string.',
  'intent: "list_in_place" when it asks what exists in or around a place; "nearest_to" when it asks which is closest to a place or record; "operator" when it asks about a company\'s sites; "count" when it asks how many; otherwise "other".',
  'radius_km: a distance the question states, as a number, else 0.',
  'Never guess coordinates. Use the question\'s own words for names.',
].join(' ');

const EMPTY = Object.freeze({
  place: '',
  region: '',
  country: '',
  entityType: 'any',
  operator: '',
  intent: 'other',
  radiusKm: 0,
});

const text = (value, max = 120) =>
  String(value ?? '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** Validate and normalise whatever the model returned; anything unusable is dropped. */
export function normalizeReading(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const entityType = text(source.entity_type ?? source.entityType, 20);
  const intent = text(source.intent, 20);
  const radius = Number(source.radius_km ?? source.radiusKm);
  return Object.freeze({
    place: text(source.place),
    region: text(source.region),
    country: text(source.country),
    entityType: ENTITY_TYPES.includes(entityType) ? entityType : 'any',
    operator: text(source.operator),
    intent: INTENTS.includes(intent) ? intent : 'other',
    radiusKm:
      Number.isFinite(radius) && radius > 0 ? Math.min(5000, radius) : 0,
  });
}

/** Whether a reading carries anything retrieval can use. */
export const isEmptyReading = (reading) =>
  !reading.place && !reading.region && !reading.country && !reading.operator;

/** The empty reading: retrieval behaves as it did before the reader existed. */
export const EMPTY_READING = EMPTY;

/**
 * Ask the model to read the question.
 * @returns {Promise<{reading: object, source: 'model'|'fallback', ms: number, error?: string}>}
 */
export async function readQuestion({
  question,
  runtimeUrl,
  model,
  reasoningEffort = 'none',
  fetchImpl = globalThis.fetch,
  signal,
}) {
  const started = Date.now();
  if (!model || !runtimeUrl)
    return { reading: EMPTY, source: 'fallback', ms: 0 };
  try {
    const response = await fetchImpl(
      `${String(runtimeUrl).replace(/\/+$/, '')}/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          temperature: 0,
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
          response_format: { type: 'json_schema', json_schema: READING_SCHEMA },
          messages: [
            { role: 'system', content: READER_PROMPT },
            { role: 'user', content: question },
          ],
        }),
        signal,
      },
    );
    if (!response.ok)
      throw new Error(`reader runtime returned ${response.status}`);
    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content ?? '';
    const reading = normalizeReading(JSON.parse(content));
    return { reading, source: 'model', ms: Date.now() - started };
  } catch (error) {
    return {
      reading: EMPTY,
      source: 'fallback',
      ms: Date.now() - started,
      error: String(error?.message ?? error).slice(0, 200),
    };
  }
}
