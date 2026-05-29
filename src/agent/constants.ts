/**
 * Named constants used throughout the agent.
 *
 * Every classification/urgency/policy-topic/etc. lives here so the
 * rest of the codebase never has a magic string. Add or rename a
 * value here and the compiler will tell you everywhere it needs to
 * propagate.
 *
 * Sections (in reading order):
 *   1. Output enums (urgency, classification, assignee, policy topic)
 *   2. Channel + draft-channel + language enums
 *   3. Insurance status returned by verify_insurance
 *   4. Due-date offsets used when building task `due` fields
 *   5. Keyword lists used by the signal detectors in ./signals
 *   6. Known payer-name fragments used by ./extraction
 *   7. Misc UX fallbacks
 */

import type {
  Assignee,
  Channel,
  Classification,
  PolicyTopic,
  Urgency,
} from "../types.js";

// ---------------------------------------------------------------------
// 1. Urgency / classification / assignee / policy topic
// ---------------------------------------------------------------------

/** Urgency levels - see README "Urgency Calibration". */
export const URGENCY = {
  P0: "P0",
  P1: "P1",
  P2: "P2",
  P3: "P3",
} as const satisfies Record<string, Urgency>;

/** All schema-allowed classifications. Keep in sync with schema/output.schema.json. */
export const CLASSIFICATION = {
  NEW_REFERRAL: "new_referral",
  EXISTING_PATIENT: "existing_patient_request",
  SCHEDULING: "scheduling",
  CLINICAL_QUESTION: "clinical_question",
  BILLING_QUESTION: "billing_question",
  MISSING_PAPERWORK: "missing_paperwork",
  PROVIDER_FOLLOWUP: "provider_followup",
  COMPLAINT: "complaint",
  SAFEGUARDING: "safeguarding",
  SPAM: "spam",
  OTHER: "other",
} as const satisfies Record<string, Classification>;

/** Who a task gets routed to. */
export const ASSIGNEE = {
  FRONT_DESK: "front_desk",
  INTAKE: "intake",
  BILLING: "billing",
  CLINICAL_LEAD: "clinical_lead",
} as const satisfies Record<string, Assignee>;

/** Topics that `lookup_policy` accepts. */
export const POLICY_TOPIC = {
  SERVICE_LINES: "service_lines",
  INSURANCE: "insurance",
  SAFEGUARDING: "safeguarding",
  CLINICAL_ADVICE: "clinical_advice",
  SCHEDULING: "scheduling",
  CANCELLATION: "cancellation",
  LANGUAGE_ACCESS: "language_access",
} as const satisfies Record<string, PolicyTopic>;

// ---------------------------------------------------------------------
// 2. Channels and languages
// ---------------------------------------------------------------------

/** Inbound channel - matches the `channel` field on InboxItem. */
export const CHANNEL = {
  FAX: "fax_referral",
  VOICEMAIL: "voicemail_transcript",
  PORTAL: "portal_message",
  EMAIL: "email",
} as const satisfies Record<string, Channel>;

/** Channel argument we pass to `draft_message`. */
export const DRAFT_CHANNEL = {
  PORTAL: "portal",
  EMAIL: "email",
  PHONE: "phone",
} as const;

/** Languages we draft in. */
export const LANGUAGE = {
  EN: "en",
  ES: "es",
} as const;

// ---------------------------------------------------------------------
// 3. Insurance status values
// ---------------------------------------------------------------------

/** Status strings returned by the verify_insurance mock. */
export const INSURANCE = {
  IN_NETWORK: "in_network",
  OUT_OF_NETWORK: "out_of_network",
  EXPIRED: "expired",
  UNKNOWN: "unknown",
} as const;

// ---------------------------------------------------------------------
// 4. Task due-date offsets (days from "today")
// ---------------------------------------------------------------------

/**
 * Days from today for different task urgencies. Centralised so a
 * policy change ("front desk has 4h not 24h") is a one-line edit.
 */
export const DUE_OFFSET_DAYS = {
  SAME_DAY: 0,
  NEXT_DAY: 1,
  STANDARD: 2,
  PAPERWORK_CALLBACK: 3,
} as const;

// ---------------------------------------------------------------------
// 5. Keyword lists used by the signal detectors
// ---------------------------------------------------------------------

/**
 * Phrases that indicate a safeguarding concern. Multi-word
 * fragments only - we never trigger on bare "hit" or "scared"
 * to keep false-positive risk low. Tune cautiously: missing a
 * safeguarding case is worse than triaging one as P2.
 */
export const SAFEGUARDING_KEYWORDS = [
  "rough with",
  "rough on",
  "hits him",
  "hits her",
  "hits me",
  "hitting",
  "abuse",
  "abused",
  "abusing",
  "neglect",
  "neglected",
  "afraid of",
  "scared of",
  "harm",
  "harmed",
  "unsafe",
  "bruise",
  "bruises",
  "beaten",
  "beats him",
  "beats her",
  "violent",
  "yells at",
  "screams at",
] as const;

/**
 * Phrasing that signals a clinical question (rather than a scheduling
 * request). Tuned to the visible item_5 "is it normal..." case and
 * common parent phrasings.
 */
export const CLINICAL_QUESTION_MARKERS = [
  "is it normal",
  "is this normal",
  "should i be worried",
  "should we be worried",
  "do i need",
  "do we need",
  "should we wait",
  "is something wrong",
  "what should",
  "how do i know",
] as const;

/** Phrases that signal a same-day cancellation, reschedule, or no-show. */
export const RESCHEDULE_KEYWORDS = [
  "reschedule",
  "cancel today",
  "cancel my",
  "can't make",
  "cannot make",
  "won't make",
  "missed",
  "sick",
  "fever",
  "threw up",
  "vomit",
] as const;

/**
 * Spanish-language markers. We treat the family as Spanish-preferred
 * if at least two markers appear OR the literal "espanol/español"
 * shows up. The two-marker threshold avoids triggering on
 * occasional Spanish phrases inside otherwise-English messages.
 */
export const SPANISH_PHRASE_INDICATORS = [
  "hola",
  "gracias",
  "español",
  "espanol",
  "habla",
  "teléfono",
  "telefono",
  "evaluación",
  "evaluacion",
  "mi hija",
  "mi hijo",
  "necesita",
  "tiene ",
  "soy ",
  "llamo",
  "miembro",
] as const;

/** Pattern that matches "this referral field was deliberately left blank." */
export const BLANK_MARKER_RE =
  /^\[?\s*(blank|n\/?a|tbd|missing|none|unknown|-)\s*\]?$/i;

// ---------------------------------------------------------------------
// 6. Known payer phrases
// ---------------------------------------------------------------------

/**
 * Payer name fragments we recognise in free-text bodies. Used by
 * `extractPayer` to catch unstructured mentions like
 * "Tenemos Medicaid" when no labeled "Insurance:" field is present.
 */
export const KNOWN_PAYER_PHRASES = [
  "Blue Cross Blue Shield",
  "BlueCross",
  "BCBS",
  "Aetna",
  "UnitedHealthcare",
  "United Healthcare",
  "United",
  "UHC",
  "Kaiser",
  "Cigna Select",
  "Cigna",
  "Beacon",
  "Sunrise",
  "Pediatric Choice",
  "Community First",
  "Medicaid",
] as const;

// ---------------------------------------------------------------------
// 7. Misc UX fallbacks
// ---------------------------------------------------------------------

/** Used when we genuinely have nothing better to suggest. */
export const FALLBACK_NEXT_ACTION =
  "Route to a human triager - the agent could not produce a confident next step.";
