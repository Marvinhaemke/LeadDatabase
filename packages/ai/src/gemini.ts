/**
 * Gemini Flash adapter.
 *
 * We request JSON output but don't pin a `responseSchema` — Zod is the
 * trust boundary. On parse / validation failure we retry once with the
 * error message appended; if that fails too, the row stays `pending`
 * and the cron sweeper will pick it up.
 */
import { GoogleGenerativeAI, type GenerativeModel } from '@google/generative-ai';
import { PlanSchema, type Plan } from './plan';

export interface GeminiCallContext {
  /** Compact natural-language schema summary (see schema-summary.ts). */
  schemaSummary: string;
  /** Source slug — 'zapier', 'calendly', etc. — for prompt context. */
  source: string;
  /** Optional source event hint (e.g. 'booking.created'). */
  sourceEvent?: string | null;
  /** Raw webhook payload (any JSON). */
  payload: unknown;
}

export interface GeminiCallResult {
  plan: Plan;
  promptVersion: string;
  model: string;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
}

const PROMPT_VERSION = '2026-04-28.1';

const SYSTEM_PROMPT = `
You are the ingestion brain for a sales-funnel database. Each call you receive
contains one webhook payload from an external system (form fill, calendar
event, sales-tool update, etc). Your job is to translate it into a strict
JSON "plan" that the worker will apply to the database.

Hard rules:
  1. Output ONE JSON object. No prose, no markdown fences.
  2. Identify the lead by email or phone whenever the payload contains it.
     Reuse existing leads — do NOT create duplicates.
  3. Map source field names to the schema's CANONICAL keys (use the alias
     list and the existing attribute keys provided to you).
  4. For any field that doesn't match a typed column AND isn't already a
     known attribute key, place it in \`*_attributes\` AND add an entry to
     \`field_proposals\` describing it.
  5. Emit \`events\` for every funnel-relevant transition. Examples:
       - form submission        → form_submitted
       - calendar event created → booking_created
       - calendar no-show       → booking_no_show (set booking.status too)
       - sales stage = "Won"    → won (set deal.status='won', amount, currency)
     Events are append-only: never "undo" a past event with another one;
     if the data corrects an earlier mistake, set \`action\` to 'ignore'
     and explain in \`ignore_reason\`.
  6. If you cannot identify the lead AND the payload doesn't carry useful
     funnel info (e.g. it's a heartbeat / unrelated event), set
     \`action\` = 'ignore' with a reason.
  7. Do NOT format phone numbers, dates, or money — pass them through as
     strings; the worker normalises deterministically.
  8. Be conservative with confidence: < 0.6 means a human should look.

Return shape (Zod-validated; missing optional fields are fine):

{
  "action": "apply" | "ignore",
  "ignore_reason"?: string,
  "lead_identity": { "email"?, "phone"?, "first_name"?, "last_name"?, "external_id"? },
  "lead_typed":    { "email"?, "phone"?, "first_name"?, "last_name"?, "source"? },
  "lead_attributes": { ...any string/number/bool/null/array/object },
  "booking"?: {
    "external_id"?, "meeting_type"?, "scheduled_at"?, "status"?,
    "duration_minutes"?, "previous_external_id"?, "attributes": {...}
  },
  "deal"?: {
    "stage_key"?, "status"?, "amount"?, "currency"?, "closed_at"?,
    "attributes": {...}
  },
  "events": [{ "type", "subtype"?, "occurred_at"?, "amount"?, "currency"?, "attributes": {...} }],
  "attribution"?: { "fbclid"?, "utm_source"?, "utm_medium"?, "utm_campaign"?,
                    "utm_content"?, "utm_term"?, "landing_url"?, "referrer_url"? },
  "field_proposals": [
    { "entity": "leads"|"bookings"|"deals", "field_key", "example_value",
      "inferred_type": "text"|"number"|"boolean"|"date"|"enum"|"json", "rationale"? }
  ],
  "confidence": 0..1,
  "notes"?: string
}
`.trim();

let cachedModel: GenerativeModel | null = null;
let cachedKey: string | null = null;

function getModel(): GenerativeModel {
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
  const modelName = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
  if (!apiKey) throw new Error('GOOGLE_GEMINI_API_KEY is not set');
  if (cachedModel && cachedKey === apiKey) return cachedModel;
  const genai = new GoogleGenerativeAI(apiKey);
  cachedModel = genai.getGenerativeModel({
    model: modelName,
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1,
    },
  });
  cachedKey = apiKey;
  return cachedModel;
}

export async function callGemini(ctx: GeminiCallContext): Promise<GeminiCallResult> {
  const modelName = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
  const model = getModel();
  const userPrompt = buildUserPrompt(ctx);

  const start = Date.now();
  const first = await runOnce(model, userPrompt);
  const firstParsed = parsePlan(first.text);
  if (firstParsed.ok) {
    return {
      plan: firstParsed.plan,
      promptVersion: PROMPT_VERSION,
      model: modelName,
      latencyMs: Date.now() - start,
      promptTokens: first.promptTokens,
      completionTokens: first.completionTokens,
    };
  }

  // Retry once with the parse error appended so the model can self-correct.
  const repairPrompt =
    userPrompt +
    `\n\nYour previous response failed validation:\n${firstParsed.error}\n` +
    `Return a corrected JSON object only.`;
  const second = await runOnce(model, repairPrompt);
  const secondParsed = parsePlan(second.text);
  if (!secondParsed.ok) {
    throw new Error(`Gemini plan failed validation twice: ${secondParsed.error}`);
  }
  return {
    plan: secondParsed.plan,
    promptVersion: PROMPT_VERSION,
    model: modelName,
    latencyMs: Date.now() - start,
    promptTokens: (first.promptTokens ?? 0) + (second.promptTokens ?? 0),
    completionTokens: (first.completionTokens ?? 0) + (second.completionTokens ?? 0),
  };
}

function buildUserPrompt(ctx: GeminiCallContext): string {
  return [
    `# Schema`,
    ctx.schemaSummary,
    '',
    `# Webhook source`,
    `source: ${ctx.source}`,
    ctx.sourceEvent ? `source_event: ${ctx.sourceEvent}` : '',
    '',
    `# Payload`,
    '```json',
    JSON.stringify(ctx.payload, null, 2),
    '```',
    '',
    'Produce the plan JSON now.',
  ]
    .filter(Boolean)
    .join('\n');
}

interface RawResult {
  text: string;
  promptTokens?: number;
  completionTokens?: number;
}

async function runOnce(model: GenerativeModel, prompt: string): Promise<RawResult> {
  const result = await model.generateContent(prompt);
  const text = result.response.text();
  const usage = result.response.usageMetadata;
  return {
    text,
    promptTokens: usage?.promptTokenCount,
    completionTokens: usage?.candidatesTokenCount,
  };
}

type ParseResult = { ok: true; plan: Plan } | { ok: false; error: string };

function parsePlan(text: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(stripFences(text));
  } catch (e) {
    return { ok: false, error: `JSON parse failed: ${(e as Error).message}` };
  }
  const parsed = PlanSchema.safeParse(json);
  if (!parsed.success) return { ok: false, error: parsed.error.message };
  return { ok: true, plan: parsed.data };
}

function stripFences(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('```')) {
    return trimmed
      .replace(/^```(?:json)?\s*/, '')
      .replace(/```\s*$/, '')
      .trim();
  }
  return trimmed;
}
