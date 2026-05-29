/**
 * Semantic safety net for the keyword-based classifier.
 *
 * The deterministic detectors in ./signals.ts match a fixed keyword
 * list. They are fast, auditable, and cheap, but they will miss
 * paraphrased signals - "he comes home crying after dad's weekends"
 * never trips "rough with", and "won't make it in today, she's
 * running a temp" never trips "reschedule" or "sick".
 *
 * This module wraps a single Claude Haiku call that re-examines the
 * raw body for three high-stakes signals (safeguarding, same-day
 * scheduling, clinical question) and, only on HIGH confidence,
 * upgrades the classification. The keyword classifier's output is
 * never downgraded - we only escalate, never de-escalate.
 *
 * Design constraints:
 *   - **Optional**: gated on ANTHROPIC_API_KEY. No key -> the function
 *     returns the keyword decision untouched, the agent stays fully
 *     deterministic.
 *   - **Soft-fail**: any error (auth, network, malformed response)
 *     is swallowed and the keyword decision stands. The safety net
 *     can never block a triage run.
 *   - **High confidence only**: low/medium-confidence LLM overrides
 *     are ignored. This is the precision floor the README mentions -
 *     over-escalation is itself a production failure mode.
 *   - **Auditable**: when an override happens the LLM's one-sentence
 *     rationale is embedded into the InitialDecision's rationaleSeed,
 *     so downstream decision_rationale captures why the upgrade
 *     happened.
 *   - **Skip-on-hit**: if the keyword classifier already detected
 *     one of the three urgent signals, we trust it and don't bother
 *     calling the LLM. Saves cost and avoids second-guessing
 *     confident keyword hits.
 *
 * Why not let the LLM handle classification end-to-end?
 *   - Reproducibility against hidden synthetic variants is harder.
 *   - The keyword classifier covers most cases at ~zero cost.
 *   - Layered design lets us tune the LLM independently with evals
 *     without touching the deterministic baseline.
 */

import { config as dotenvConfig } from "dotenv";
dotenvConfig({ override: true, quiet: true });

import { CLASSIFICATION, URGENCY } from "./constants.js";
import type { InitialDecision } from "./classification.js";
import type { Classification, InboxItem, Urgency } from "../types.js";

// ---------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------

/** Keyword-classifier outputs we trust without LLM second-guessing. */
const KEYWORD_TRUSTED_CLASSIFICATIONS = new Set<Classification>([
  CLASSIFICATION.SAFEGUARDING,
  CLASSIFICATION.SCHEDULING,
  CLASSIFICATION.CLINICAL_QUESTION,
]);

/** Confidence threshold required to apply an LLM override. */
const REQUIRED_CONFIDENCE = "high";

/** Signals the LLM is allowed to upgrade to. Anything else is ignored. */
type LlmOverride = "safeguarding" | "scheduling" | "clinical_question" | null;

interface LlmSignalResult {
  override: LlmOverride;
  confidence: "high" | "medium" | "low";
  rationale: string;
}

// ---------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------

/**
 * Apply the LLM semantic safety net to a keyword-derived decision.
 *
 * Returns either the original decision (most cases) or an upgraded
 * decision with the LLM's rationale embedded.
 */
export async function applySemanticSafetyNet(
  item: InboxItem,
  initial: InitialDecision,
): Promise<InitialDecision> {
  // 1. Keyword classifier already caught an urgent signal - trust it.
  if (KEYWORD_TRUSTED_CLASSIFICATIONS.has(initial.classification)) {
    return initial;
  }

  // 2. No API key configured - safety net is disabled.
  if (!process.env.ANTHROPIC_API_KEY) {
    return initial;
  }

  // 3. Ask the LLM. Soft-fail on any error.
  let result: LlmSignalResult | null = null;
  try {
    result = await llmCheck(item);
  } catch {
    return initial;
  }

  // 4. Apply the override only on a confident, recognised signal.
  if (
    result &&
    result.override &&
    result.confidence === REQUIRED_CONFIDENCE
  ) {
    return upgradeDecision(initial, result);
  }

  return initial;
}

// ---------------------------------------------------------------------
// Decision upgrade
// ---------------------------------------------------------------------

/**
 * Build the upgraded InitialDecision. The original keyword
 * classification is named in the rationale so the audit trail shows
 * what the safety net changed and why.
 */
function upgradeDecision(
  initial: InitialDecision,
  result: LlmSignalResult,
): InitialDecision {
  const upgradePath: Record<NonNullable<LlmOverride>, { classification: Classification; urgency: Urgency }> = {
    safeguarding: {
      classification: CLASSIFICATION.SAFEGUARDING,
      urgency: URGENCY.P0,
    },
    scheduling: {
      classification: CLASSIFICATION.SCHEDULING,
      urgency: URGENCY.P1,
    },
    clinical_question: {
      classification: CLASSIFICATION.CLINICAL_QUESTION,
      urgency: URGENCY.P2,
    },
  };

  const target = upgradePath[result.override!];

  return {
    classification: target.classification,
    urgency: target.urgency,
    rationaleSeed: `LLM semantic safety net (high confidence) upgraded classification from ${initial.classification} to ${target.classification}: "${result.rationale}". Original keyword-classifier seed: "${initial.rationaleSeed}"`,
  };
}

// ---------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------

/**
 * Single Haiku call. Returns the parsed signal result, or null if
 * the response wasn't parseable.
 */
async function llmCheck(item: InboxItem): Promise<LlmSignalResult | null> {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 200,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: buildUserPrompt(item),
      },
    ],
  });

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || !("text" in textBlock)) return null;

  return parseLlmJson(textBlock.text);
}

/**
 * Parses the LLM's JSON response. Strips common fence wrappers so a
 * stray ```json prefix doesn't break us. Returns null on any parse
 * issue; the caller treats null as "no override".
 */
function parseLlmJson(raw: string): LlmSignalResult | null {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(stripped) as Partial<LlmSignalResult>;
    if (
      !parsed ||
      (parsed.override !== null &&
        parsed.override !== "safeguarding" &&
        parsed.override !== "scheduling" &&
        parsed.override !== "clinical_question") ||
      (parsed.confidence !== "high" &&
        parsed.confidence !== "medium" &&
        parsed.confidence !== "low") ||
      typeof parsed.rationale !== "string"
    ) {
      return null;
    }
    return parsed as LlmSignalResult;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------

const SYSTEM_PROMPT = [
  "You are a semantic safety net for a pediatric therapy practice's inbox triage system.",
  "",
  "A deterministic keyword classifier already ran on this item and did NOT detect any of three urgent signals. Your job is to re-examine the raw message and tell me if the keyword classifier missed one of them.",
  "",
  "Signals (with policy guidance):",
  "",
  "1. `safeguarding`: ANY disclosure suggesting harm, abuse, neglect, or unsafe caregiving - even paraphrased. Examples that keywords would miss:",
  "   - \"he comes home crying after dad's weekends\"",
  "   - \"things at home have been hard lately, he flinches\"",
  "   - \"mom yelled in front of the kids\"",
  "   This is P0 - getting this wrong is the worst possible outcome.",
  "",
  "2. `scheduling`: same-day cancellation, no-show, illness, or running late for an EXISTING appointment. Examples:",
  "   - \"won't make it in today, she's running a temp\"",
  "   - \"sorry, family emergency, need to skip today's session\"",
  "   - \"stuck in traffic, will be 30+ late\"",
  "   This is P1.",
  "",
  "3. `clinical_question`: parent asking for clinical guidance over message. Examples:",
  "   - \"wondering if his speech is on track\"",
  "   - \"is what we're seeing typical at this age\"",
  "   - \"do you think this needs a specialist\"",
  "   This is P2 - the agent must deflect to a screening, not answer the clinical question.",
  "",
  "Rules:",
  "- Use HIGH confidence only when the signal is clear and specific. Default to LOW when uncertain.",
  "- Over-escalation is itself a failure mode. If unsure, return null override.",
  "- Output JSON ONLY, no prose. No code fences.",
  "",
  "Output schema:",
  "  {\"override\": \"safeguarding\" | \"scheduling\" | \"clinical_question\" | null, \"confidence\": \"high\" | \"medium\" | \"low\", \"rationale\": \"one short sentence\"}",
].join("\n");

function buildUserPrompt(item: InboxItem): string {
  return [
    `Channel: ${item.channel}`,
    `Subject: ${item.subject}`,
    `Body: ${item.body}`,
    "",
    "Return the JSON now.",
  ].join("\n");
}
