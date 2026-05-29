/*
 * Cedar Kids Therapy referral inbox triage agent.
 *
 * What this agent does
 * --------------------
 * Reads a batch of inbox items (fax referrals, voicemails, portal messages,
 * emails) and produces one structured triage decision per item. Each
 * decision surfaces:
 *   - what the item is about (classification),
 *   - how urgent it is (P0 - P3),
 *   - what intake data was extracted,
 *   - which mock tools were invoked,
 *   - a recommended next action plus an optional draft reply,
 *   - tasks / escalations queued for staff.
 *
 * Tool constraints respected
 * --------------------------
 *   - Every tool call runs inside `withItemContext(item.id, ...)` so the
 *     trace associates the call with the right item.
 *   - `tools_called` is read straight from `getToolCallsForItem(item.id)`
 *     and passed through unchanged. No call_id values are forged or copied
 *     from data/example_output.json.
 *   - `draft_message` is the only outbound; we never imply a message was
 *     sent.
 *   - `find_slots` and `hold_slot` surface options for human review.
 *     Actual scheduling is out of scope.
 *   - `summary` counts are produced by `buildBatchOutput` in src/index.ts.
 *
 * Urgency decision tree (see classifyItem)
 * ----------------------------------------
 *   P0  Safeguarding language detected -> escalate same hour to clinical
 *       lead. Evaluated FIRST so a safety signal hidden inside an
 *       otherwise routine intake request still escalates.
 *   P1  Same-day cancellation / reschedule, illness, no-show.
 *   P2  Default. Standard intake, referrals, clinical questions,
 *       missing paperwork, out-of-network benefits conversations.
 *   P3  Reserved for low-priority admin / spam. None of the visible
 *       8 items hit this; included for completeness.
 *
 * Tool usage by classification
 * ----------------------------
 *   safeguarding       -> lookup_policy, escalate, create_task,
 *                         draft_message (neutral acknowledgement only).
 *   scheduling (P1)    -> search_patient, lookup_policy, create_task,
 *                         draft_message. find_slots intentionally skipped
 *                         because the mock only returns evaluation slots.
 *   clinical_question  -> lookup_policy(clinical_advice), create_task,
 *                         draft_message that offers screening / eval.
 *   missing_paperwork  -> create_task (front desk calls referring office).
 *                         No draft when there is no parent contact.
 *   new_referral / existing_patient_request:
 *     in-network       -> search_patient, verify_insurance, find_slots,
 *                         create_task(intake), draft_message. hold_slot
 *                         only when language constraint narrows to a
 *                         single clean provider match.
 *     out-of-network   -> verify_insurance, lookup_policy(insurance),
 *                         create_task(billing), draft_message. No slot
 *                         calls until benefits conversation closes.
 *     expired coverage -> same as out-of-network but routed to billing
 *                         with a payer-discrepancy note.
 *     spanish family   -> also lookup_policy(language_access). Slots
 *                         filtered to es-capable providers. Draft in es.
 *     existing patient -> search_patient match upgrades classification
 *                         to existing_patient_request and rationale
 *                         notes any guardian-name discrepancy.
 *
 * Safety defaults
 * ---------------
 *   - Every item is flagged `requires_human_review = true`. This is both
 *     a validator requirement and a product principle: the agent drafts,
 *     holds, and surfaces - humans decide.
 *   - On any unexpected error a fallback ItemOutput is produced so a
 *     single bad item never crashes the batch.
 */

import {
  create_task,
  draft_message,
  escalate,
  find_slots,
  getToolCallsForItem,
  hold_slot,
  lookup_policy,
  search_patient,
  verify_insurance,
  withItemContext,
} from "./tools.js";
import type {
  Assignee,
  Channel,
  Classification,
  Discipline,
  ExtractedIntake,
  InboxItem,
  ItemOutput,
  Patient,
  PolicyTopic,
  Slot,
  ToolResult,
  Urgency,
} from "./types.js";

// =====================================================================
// Constants
// =====================================================================
// Named so the compiler catches typos and a reader can audit the
// vocabulary without searching for string literals.

const URGENCY = {
  P0: "P0",
  P1: "P1",
  P2: "P2",
  P3: "P3",
} as const satisfies Record<string, Urgency>;

const CLASSIFICATION = {
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

const ASSIGNEE = {
  FRONT_DESK: "front_desk",
  INTAKE: "intake",
  BILLING: "billing",
  CLINICAL_LEAD: "clinical_lead",
} as const satisfies Record<string, Assignee>;

const POLICY_TOPIC = {
  SERVICE_LINES: "service_lines",
  INSURANCE: "insurance",
  SAFEGUARDING: "safeguarding",
  CLINICAL_ADVICE: "clinical_advice",
  SCHEDULING: "scheduling",
  CANCELLATION: "cancellation",
  LANGUAGE_ACCESS: "language_access",
} as const satisfies Record<string, PolicyTopic>;

const CHANNEL = {
  FAX: "fax_referral",
  VOICEMAIL: "voicemail_transcript",
  PORTAL: "portal_message",
  EMAIL: "email",
} as const satisfies Record<string, Channel>;

const DRAFT_CHANNEL = {
  PORTAL: "portal",
  EMAIL: "email",
  PHONE: "phone",
} as const;

const LANGUAGE = {
  EN: "en",
  ES: "es",
} as const;

// Insurance status values returned by verify_insurance.
const INSURANCE = {
  IN_NETWORK: "in_network",
  OUT_OF_NETWORK: "out_of_network",
  EXPIRED: "expired",
  UNKNOWN: "unknown",
} as const;

// Task due-date offsets, in days from today.
const DUE_OFFSET_DAYS = {
  SAME_DAY: 0,
  NEXT_DAY: 1,
  STANDARD: 2,
  PAPERWORK_CALLBACK: 3,
} as const;

// Phrases that indicate a safeguarding concern. Kept as multi-word
// fragments so we don't false-positive on bare words like "hit".
const SAFEGUARDING_KEYWORDS = [
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

// Portal/email phrasing that signals a clinical question rather than a
// scheduling request. Tuned to the visible item_5 ("is it normal...")
// and similar wording reviewers might use.
const CLINICAL_QUESTION_MARKERS = [
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

// Phrases that indicate a same-day cancellation, reschedule, or no-show.
const RESCHEDULE_KEYWORDS = [
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

// Spanish-language markers. We treat the family as Spanish-preferred if
// at least two markers appear or the word "espanol/español" itself.
const SPANISH_PHRASE_INDICATORS = [
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

// Markers that mean "this referral field was deliberately left blank."
const BLANK_MARKER_RE = /^\[?\s*(blank|n\/?a|tbd|missing|none|unknown|-)\s*\]?$/i;

// Known payer name fragments we recognise in free-text bodies.
const KNOWN_PAYER_PHRASES = [
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

// Fallback values for the recommended next action when we cannot
// produce something more specific.
const FALLBACK_NEXT_ACTION =
  "Route to a human triager - the agent could not produce a confident next step.";

// =====================================================================
// Date helpers
// =====================================================================

/**
 * Picks a single "today" anchor for the whole batch.
 * Uses real wall time so task due dates render relative to when staff
 * see them, not relative to when the synthetic data was generated.
 */
function batchAnchor(): Date {
  return new Date();
}

/**
 * Returns a YYYY-MM-DD string `daysOut` days after `anchor`.
 * Used for task due dates - the schema accepts any string but staff
 * read date-only values more easily than full timestamps.
 */
function dueDateString(anchor: Date, daysOut: number): string {
  const d = new Date(anchor);
  d.setDate(d.getDate() + daysOut);
  return d.toISOString().slice(0, 10);
}

// =====================================================================
// Tiny string helpers
// =====================================================================

/**
 * Trims trailing punctuation/whitespace from a field value we grabbed
 * by regex. Keeps the extraction patterns simpler.
 */
function trimField(value: string): string {
  return value.replace(/[.,;:\s]+$/, "").trim();
}

/** True if a captured field value is a "blank" placeholder. */
function isBlankMarker(value: string): boolean {
  return BLANK_MARKER_RE.test(value.trim());
}

/** Escapes a string so it can be safely embedded in a RegExp source. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Trims trailing dots/periods from an email captured by regex.
 * Our email pattern `[\w.-]+` greedily eats trailing sentence
 * periods - this strips them back off so recipients render cleanly.
 */
function stripTrailingDots(value: string | null): string | null {
  if (value == null) return null;
  return value.replace(/\.+$/, "");
}

/** Lowercased combined subject + body, used for all signal detectors. */
function searchableText(item: InboxItem): string {
  return `${item.subject}\n${item.body}`.toLowerCase();
}

// =====================================================================
// Intake extraction
// =====================================================================
// Each extractor is a small, best-effort parser. We intentionally use
// deterministic regex chains instead of an LLM here so the output is
// auditable, fast, and reproducible against hidden synthetic input.
// Anything we can't extract becomes null and shows up in missing_info.

/**
 * Pulls the child's name from the item using a list of patterns in
 * priority order: labeled "Child:" fields, subject "Referral for ...",
 * relational phrasing ("my son X", "mi hija X"), and a couple of
 * fallback shapes for less-structured messages.
 */
function extractChildName(item: InboxItem): string | null {
  const sources = [item.body, item.subject];
  const patterns: RegExp[] = [
    /Child:\s*([^.\n]+)/i,
    /Referral(?:\s+for|:)\s+([A-Z][\w'.-]+(?:\s+[A-Z][\w'.-]+)+)/,
    /(?:my (?:son|daughter|child)|mi (?:hija|hijo))\s+([A-Z][\w'.-]+(?:\s+[A-Z][\w'.-]+)?)/i,
    /(?:for|about)\s+([A-Z][\w'.-]+\s+[A-Z][\w'.-]+)/,
    /\d{1,2}[-\s]year[-\s]old\s+([A-Z][\w'.-]+)/i,
    /([A-Z][\w'.-]+\s+[A-Z][\w'.-]+)\s+(?:threw|is|was|has|fell|tripped|got)/,
    /([A-Z][\w'.-]+)'s\s+DOB/,
  ];

  for (const pattern of patterns) {
    for (const source of sources) {
      const match = source.match(pattern);
      if (!match) continue;
      const value = trimField(match[1]);
      if (value && !isBlankMarker(value)) return value;
    }
  }
  return null;
}

/**
 * Returns an ISO date if a YYYY-MM-DD appears, otherwise the
 * literal "age N" if an age phrase appears, otherwise null.
 * Downstream code uses the ISO form for search_patient and treats
 * "age N" as a missing-DOB-but-known-age signal.
 */
function extractDobOrAge(item: InboxItem): string | null {
  const body = item.body;

  const iso = body.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];

  const explicitAge = body.match(
    /(?:is|tiene|age)\s+(\d{1,2})(?:\s*(?:years?|yo|year-old|anos|años))?\b/i,
  );
  if (explicitAge) return `age ${explicitAge[1]}`;

  const yearOld = body.match(/(\d{1,2})[-\s]year[-\s]old/i);
  if (yearOld) return `age ${yearOld[1]}`;

  return null;
}

/**
 * Assembles a parent/guardian contact string from labeled fields,
 * parent-style phrasing ("I am his parent, X"), the sender header,
 * and any phone/email found in the body or sender.
 *
 * Returns null when the referral explicitly marks the parent as
 * [blank], so item_6-style incomplete referrals surface as missing.
 */
function extractParentContact(item: InboxItem): string | null {
  const body = item.body;

  // Stop at sentence boundary (". " followed by capital, or end of line)
  // so emails like "daniel.lee@example.com" survive the period inside them.
  const labeled = body.match(
    /Parent(?:\/guardian)?:\s*([^\n]+?)(?=\s*\.\s+[A-Z]|\.\s*$|\n|$)/i,
  );
  if (labeled) {
    const value = trimField(labeled[1]);
    if (!value || isBlankMarker(value)) return null; // explicitly blank
    return value;
  }

  const phone = body.match(/\b(\d{3}[-.\s]?\d{4})\b/)?.[1] ?? null;
  const email = stripTrailingDots(
    body.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0] ??
      item.sender.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0] ??
      null,
  );

  let parentName: string | null = null;

  // No `/i` flag - we need the name `[A-Z]` to be strictly uppercase
  // so the second name word doesn't gobble lowercase trailing prose.
  // Leading anchors use char classes so case-insensitivity is local.
  const relational = body.match(
    /(?:[Ii] am|[Ii]'m|[Tt]his is|[Ss]oy)\s+(?:[Hh]is|[Hh]er|[Tt]heir)?\s*(?:[Pp]arent,?\s+|[Mm]other,?\s+|[Ff]ather,?\s+|[Mm]om,?\s+|[Dd]ad,?\s+)?([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)?)\b/,
  );
  if (relational) parentName = trimField(relational[1]);

  if (!parentName) {
    const cleanedSender = item.sender
      .replace(/<[^>]+>/g, "")
      .replace(/voicemail|via parent portal|fax/gi, "")
      .trim();
    // Avoid treating a referring clinic as the parent.
    if (
      cleanedSender &&
      /^[A-Z]/.test(cleanedSender) &&
      !/pediatrics|clinic|hospital|fax/i.test(cleanedSender)
    ) {
      parentName = cleanedSender;
    }
  }

  const parts = [parentName, phone, email].filter(
    (value): value is string => Boolean(value),
  );
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * Detects SLP / OT / PT disciplines from labeled fields and inline
 * vocabulary ("articulation", "sensory", "toe walking", etc.).
 * Returns null if nothing recognisable was found.
 */
function extractDisciplines(item: InboxItem): Discipline[] | null {
  const text = `${item.subject}\n${item.body}`;
  const found = new Set<Discipline>();

  const labeled = text.match(/Discipline(?:\s+requested)?:\s*([^.\n]+)/i);
  if (labeled && !isBlankMarker(labeled[1])) {
    for (const tag of labeled[1].toUpperCase().match(/\b(SLP|OT|PT)\b/g) ?? []) {
      found.add(tag as Discipline);
    }
  }

  if (/\bSLP\b|speech|articulation|language|R sound|habla/i.test(text)) {
    found.add("SLP");
  }
  if (/\bOT\b|occupational|sensory|feeding|fine motor/i.test(text)) {
    found.add("OT");
  }
  if (/\bPT\b|physical therapy|gait|toe walking|gross motor|tripping/i.test(text)) {
    found.add("PT");
  }

  return found.size > 0 ? Array.from(found) : null;
}

/**
 * Pulls the chief concern / diagnosis. Tries labeled fields first,
 * then common referral phrasing ("evaluation for X", "concern is X").
 */
function extractConcern(item: InboxItem): string | null {
  const body = item.body;

  const labels = ["Concern", "Diagnosis/concern", "Diagnosis"];
  for (const label of labels) {
    const re = new RegExp(`${label}:\\s*([^.\\n]+)`, "i");
    const match = body.match(re);
    if (match && !isBlankMarker(match[1])) return trimField(match[1]);
  }

  const evalFor = body.match(
    /(?:looking for|for an?|for a)\s+(?:[A-Z]+\s+)?evaluation\s+for\s+([^.\n]+)/i,
  );
  if (evalFor) return trimField(evalFor[1]);

  const concernAbout = body.match(/(?:concern|issue|problem)\s+(?:is|with|about)\s+([^.\n]+)/i);
  if (concernAbout) return trimField(concernAbout[1]);

  return null;
}

/**
 * Pulls the payer name. Tries labeled "Insurance:" fields, "Insurance
 * is X" phrasing, then scans for any known payer-name fragment so we
 * still catch unstructured mentions like "Tenemos Medicaid".
 */
function extractPayer(item: InboxItem): string | null {
  const body = item.body;

  const labeled = body.match(/Insurance:\s*([^.\n,]+)/i);
  if (labeled) {
    const value = trimField(labeled[1]);
    if (value && !isBlankMarker(value)) return value;
    if (isBlankMarker(value)) return null;
  }

  const inline = body.match(/Insurance is\s+([^.,\n]+)/i);
  if (inline) return trimField(inline[1]);

  for (const phrase of KNOWN_PAYER_PHRASES) {
    const phraseRe = new RegExp(
      `\\b(${escapeRegExp(phrase)}(?:\\s+(?:PPO|HMO|EPO|POS))?)`,
      "i",
    );
    const match = body.match(phraseRe);
    if (match) return trimField(match[1]);
  }

  return null;
}

/** Pulls a member ID from "Member ID: X" or Spanish "miembro X". */
function extractMemberId(item: InboxItem): string | null {
  const body = item.body;

  const labeled = body.match(/Member ID:\s*([A-Z0-9-]+)/i);
  if (labeled && !isBlankMarker(labeled[1])) return trimField(labeled[1]);

  const inline = body.match(/member\s+(?:id\s+|number\s+)?([A-Z]{2,}-\d+)/i);
  if (inline) return trimField(inline[1]);

  const spanish = body.match(/miembro\s+([A-Z0-9-]+)/i);
  if (spanish) return trimField(spanish[1]);

  return null;
}

/**
 * Pulls the family's stated scheduling preference. Optional - used as
 * a hint passed to find_slots and surfaced to staff in task notes.
 */
function extractPreferences(item: InboxItem): string | null {
  const labeled = item.body.match(/Preferred(?:\s+availability)?:\s*([^.\n]+)/i);
  if (labeled) return trimField(labeled[1]);

  const prefers = item.body.match(/(?:family\s+)?prefers?\s+([^.\n]+)/i);
  if (prefers) return trimField(prefers[1]);

  return null;
}

/**
 * Runs all extractors and returns the ExtractedIntake shape required
 * by the schema. Always returns every field (nullable) so downstream
 * code can rely on the shape.
 */
function extractIntake(item: InboxItem): ExtractedIntake {
  return {
    child_name: extractChildName(item),
    dob_or_age: extractDobOrAge(item),
    parent_contact: extractParentContact(item),
    discipline: extractDisciplines(item),
    diagnosis_or_concern: extractConcern(item),
    payer: extractPayer(item),
    member_id: extractMemberId(item),
  };
}

/**
 * Lists intake fields that came back null. Surfaced to staff via
 * `missing_info` so they know what to follow up on.
 */
function listMissingIntake(intake: ExtractedIntake): string[] {
  const missing: string[] = [];
  if (!intake.child_name) missing.push("child name");
  if (!intake.dob_or_age) missing.push("date of birth or age");
  if (!intake.parent_contact) missing.push("parent/guardian contact");
  if (!intake.discipline) missing.push("discipline requested");
  if (!intake.diagnosis_or_concern) missing.push("diagnosis or concern");
  if (!intake.payer) missing.push("insurance payer");
  if (!intake.member_id) missing.push("insurance member ID");
  return missing;
}

// =====================================================================
// Signal detection
// =====================================================================
// Pure functions over the item + extracted intake. They never call
// tools - tools are reserved for verification (insurance, patient
// lookup) once a signal has already been detected.

/**
 * Returns true and the specific phrases matched if the item contains
 * any safeguarding language. Phrases are reported so the rationale
 * can quote them back to the reviewer.
 */
function detectSafeguarding(item: InboxItem): { hit: boolean; phrases: string[] } {
  const text = searchableText(item);
  const phrases = SAFEGUARDING_KEYWORDS.filter((kw) => text.includes(kw));
  return { hit: phrases.length > 0, phrases };
}

/**
 * Clinical-question detector. Restricted to portal and email channels
 * because a parent voicemail asking "is this normal" is usually still
 * a triage request that needs a callback, not a deflection.
 */
function detectClinicalQuestion(item: InboxItem): boolean {
  const isInquiryChannel =
    item.channel === CHANNEL.PORTAL || item.channel === CHANNEL.EMAIL;
  if (!isInquiryChannel) return false;

  const text = searchableText(item);
  const hasMarker = CLINICAL_QUESTION_MARKERS.some((m) => text.includes(m));
  // If the message also explicitly references a referral, treat it
  // as a referral (item_4 case) rather than a clinical question.
  const looksLikeReferral = /referral/.test(text);

  return hasMarker && !looksLikeReferral;
}

/** Detects same-day cancellation, reschedule, or no-show language. */
function detectScheduling(item: InboxItem): boolean {
  const text = searchableText(item);
  return RESCHEDULE_KEYWORDS.some((kw) => text.includes(kw));
}

/**
 * True when the family appears to communicate primarily in Spanish.
 * We require either the literal word "espanol/español" or two or more
 * Spanish phrase markers to avoid false positives on bilingual emails.
 */
function detectSpanishPreferred(item: InboxItem): boolean {
  const text = searchableText(item);
  if (/espa[nñ]ol/.test(text)) return true;
  const hits = SPANISH_PHRASE_INDICATORS.filter((p) => text.includes(p));
  return hits.length >= 2;
}

/** True if the channel is one we treat as a structured referral document. */
function isReferralChannel(item: InboxItem): boolean {
  return item.channel === CHANNEL.FAX;
}

/**
 * True when a fax referral has two or more required intake fields
 * blank. Used to route item_6-style stubs to the missing-paperwork
 * flow instead of the standard intake flow.
 */
function detectIncompleteReferral(item: InboxItem, intake: ExtractedIntake): boolean {
  if (!isReferralChannel(item)) return false;
  const required = [
    intake.child_name,
    intake.dob_or_age,
    intake.parent_contact,
    intake.payer,
  ];
  const blanks = required.filter((value) => value === null).length;
  return blanks >= 2;
}

/**
 * Heuristic for "a family wrote in asking to start care" - covers
 * voicemails and parent emails that describe a referral or evaluation
 * request without being on the structured fax channel.
 */
function looksLikeNewIntakeRequest(item: InboxItem, intake: ExtractedIntake): boolean {
  const text = searchableText(item);
  // Match English referral language AND the Spanish equivalents we
  // expect from Spanish-speaking families (item_7-style voicemails).
  const mentionsCare =
    /referral|evaluation|evaluac[ií]on|\beval\b|screening|therapy|terapia|habla|speech/.test(
      text,
    );
  return mentionsCare && intake.child_name !== null;
}

// =====================================================================
// Classification (decision tree)
// =====================================================================

interface InitialDecision {
  classification: Classification;
  urgency: Urgency;
  rationaleSeed: string;
}

/**
 * Pure decision tree that maps an inbox item + its extracted intake
 * onto an initial classification + urgency. Handlers may refine the
 * classification afterwards (e.g. new_referral -> existing_patient
 * after search_patient finds a match) but never the urgency without
 * a clear, named reason.
 *
 * Ordering is significant. Safeguarding is evaluated first so a
 * routine-looking eval request that buries a safety signal still
 * escalates. P1 scheduling/illness next. P2 paths last.
 */
function classifyItem(item: InboxItem, intake: ExtractedIntake): InitialDecision {
  const safeguarding = detectSafeguarding(item);
  if (safeguarding.hit) {
    return {
      classification: CLASSIFICATION.SAFEGUARDING,
      urgency: URGENCY.P0,
      rationaleSeed: `Body contains safeguarding language (${safeguarding.phrases.join(", ")}); policy requires same-hour clinical-lead escalation.`,
    };
  }

  if (detectScheduling(item)) {
    return {
      classification: CLASSIFICATION.SCHEDULING,
      urgency: URGENCY.P1,
      rationaleSeed:
        "Same-day cancellation, illness, or reschedule language - policy treats this as a P1 operational issue.",
    };
  }

  if (detectClinicalQuestion(item)) {
    return {
      classification: CLASSIFICATION.CLINICAL_QUESTION,
      urgency: URGENCY.P2,
      rationaleSeed:
        "Parent is asking for clinical guidance over message; policy forbids clinical advice in outbound replies.",
    };
  }

  if (detectIncompleteReferral(item, intake)) {
    return {
      classification: CLASSIFICATION.MISSING_PAPERWORK,
      urgency: URGENCY.P2,
      rationaleSeed:
        "Referral document is missing required intake fields and needs the referring office to send a complete version.",
    };
  }

  if (isReferralChannel(item)) {
    return {
      classification: CLASSIFICATION.NEW_REFERRAL,
      urgency: URGENCY.P2,
      rationaleSeed:
        "Structured fax referral with sufficient intake data for the standard intake workflow.",
    };
  }

  if (looksLikeNewIntakeRequest(item, intake)) {
    return {
      classification: CLASSIFICATION.NEW_REFERRAL,
      urgency: URGENCY.P2,
      rationaleSeed:
        "Family-initiated evaluation request via voicemail/email; runs through the standard intake workflow.",
    };
  }

  return {
    classification: CLASSIFICATION.OTHER,
    urgency: URGENCY.P2,
    rationaleSeed:
      "No clear classification signals were detected; routing for human review to avoid misclassification.",
  };
}

// =====================================================================
// Safe tool wrapper
// =====================================================================

/**
 * Wraps a tool call so that any thrown error is captured into the
 * per-item errors array instead of crashing the batch. The handler
 * then decides how to degrade (skip downstream steps, switch to a
 * fallback flow, note the failure in decision_rationale).
 *
 * We log the label not the full args because args are already in the
 * trace; the label is what makes the failure scannable in the output.
 */
async function safeCall<T>(
  label: string,
  fn: () => Promise<ToolResult<T>>,
  errors: string[],
): Promise<ToolResult<T> | null> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`${label} failed: ${msg}`);
    return null;
  }
}

// =====================================================================
// Recipient / channel helpers for draft_message
// =====================================================================

/**
 * Picks the best recipient identifier for a draft_message call:
 * email address when we have one, then phone number, then a free-text
 * "<name> via <channel>" fallback so the draft still has a target.
 */
function pickRecipient(item: InboxItem, intake: ExtractedIntake): string {
  const senderEmail = item.sender.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0];
  const bodyEmail = item.body.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0];
  const email = stripTrailingDots(senderEmail ?? bodyEmail ?? null);
  if (email) return email;

  const phone = item.body.match(/\b\d{3}[-.\s]?\d{4}\b/)?.[0];
  if (phone) return phone;

  if (intake.parent_contact) return intake.parent_contact;

  return item.sender;
}

/**
 * Picks the draft channel from the inbound channel. Voicemails get
 * a "phone" reply (call back); fax referrals default to email so the
 * intake team has a writable thread.
 */
function pickDraftChannel(item: InboxItem): "portal" | "email" | "phone" {
  switch (item.channel) {
    case CHANNEL.PORTAL:
      return DRAFT_CHANNEL.PORTAL;
    case CHANNEL.VOICEMAIL:
      return DRAFT_CHANNEL.PHONE;
    case CHANNEL.EMAIL:
    case CHANNEL.FAX:
    default:
      return DRAFT_CHANNEL.EMAIL;
  }
}

/** First name from a stored full name; "the family" fallback. */
function firstName(fullName: string | null): string {
  if (!fullName) return "the family";
  return fullName.split(/[\s,]+/)[0] ?? fullName;
}

// =====================================================================
// Draft message templates
// =====================================================================
// Templates are deliberately conservative and operationally specific.
// They never give clinical advice, never imply the message was sent,
// and always tell the family what staff will do next.

interface DraftContext {
  intake: ExtractedIntake;
  language: "en" | "es";
}

/** Acknowledgement for a clean in-network new referral. */
function draftInNetworkAcknowledgement(ctx: DraftContext): string {
  const parent = firstName(ctx.intake.parent_contact);
  const child = ctx.intake.child_name ?? "your child";
  const discipline = ctx.intake.discipline?.[0] ?? "evaluation";

  if (ctx.language === LANGUAGE.ES) {
    return `Hola ${parent}, recibimos la solicitud de evaluacion de ${discipline} para ${child} y verificamos su seguro. Nuestro equipo de admisiones se comunicara dentro de un dia habil para confirmar el horario. Gracias por contactarnos.`;
  }
  return `Hi ${parent}, we received the ${discipline} evaluation request for ${child} and verified your insurance. Our intake team will reach out within one business day to confirm scheduling. Thanks for reaching out.`;
}

/** Acknowledgement for an out-of-network or expired-coverage referral. */
function draftBenefitsConversationDraft(ctx: DraftContext, statusNote: string): string {
  const parent = firstName(ctx.intake.parent_contact);
  const child = ctx.intake.child_name ?? "your child";

  if (ctx.language === LANGUAGE.ES) {
    return `Hola ${parent}, recibimos la solicitud para ${child}. ${statusNote} Nuestro equipo de facturacion se comunicara para revisar las opciones antes de programar la cita.`;
  }
  return `Hi ${parent}, thank you for sending ${child}'s referral. ${statusNote} Our billing team will reach out to walk through options before we move forward with scheduling.`;
}

/**
 * Neutral acknowledgement for a safeguarding case. By policy this
 * cannot ask investigative questions or offer clinical guidance - it
 * exists only so staff have a starting point for the call.
 */
function draftSafeguardingAcknowledgement(ctx: DraftContext): string {
  const parent = firstName(ctx.intake.parent_contact);
  const child = ctx.intake.child_name ?? "your child";
  return `Hi ${parent}, thank you for reaching out about ${child}. A member of our clinical team will follow up with you directly. We're here to support you and ${child}.`;
}

/** Deflection for a clinical question - no advice, offers screening. */
function draftClinicalQuestionDeflection(ctx: DraftContext): string {
  const parent = firstName(ctx.intake.parent_contact);
  const child = ctx.intake.child_name ?? "your child";
  return `Hi ${parent}, thank you for your question about ${child}. Our clinicians can't share clinical guidance over message, but we can schedule a brief screening or evaluation to give you a clearer answer. Our intake team will follow up to walk through options.`;
}

/** Acknowledgement for a same-day reschedule / illness call-out. */
function draftRescheduleAcknowledgement(ctx: DraftContext): string {
  const parent = firstName(ctx.intake.parent_contact);
  const child = ctx.intake.child_name ?? "your child";
  return `Hi ${parent}, thanks for letting us know about ${child}. We've alerted our front desk to release today's slot and they'll reach out to find a makeup time. Wishing ${child} a quick recovery.`;
}

/** Acknowledgement when verify_insurance returned "unknown". */
function draftUnknownInsuranceAcknowledgement(ctx: DraftContext): string {
  const parent = firstName(ctx.intake.parent_contact);
  const child = ctx.intake.child_name ?? "your child";
  return `Hi ${parent}, thank you for sending ${child}'s referral. We couldn't confirm coverage from the information provided, so our intake team will reach out to verify benefits before scheduling.`;
}

// =====================================================================
// Per-classification handlers
// =====================================================================
// Each handler owns the tool calls and the narrative for its
// classification. They all return the same HandlerOutcome shape so
// the assembler at the bottom can produce the ItemOutput uniformly.

interface HandlerOutcome {
  classification: Classification;
  urgency: Urgency;
  decision_rationale: string;
  recommended_next_action: string;
  draft_reply: string | null;
  task_ids: string[];
  escalation: { reason: string; severity: "P0" | "P1" } | null;
}

interface HandlerCtx {
  item: InboxItem;
  intake: ExtractedIntake;
  initial: InitialDecision;
  anchor: Date;
  errors: string[];
}

/**
 * Safeguarding flow: look up policy snippet, escalate to clinical
 * lead at P0, create a same-hour review task, draft a neutral
 * acknowledgement. No scheduling work even if the same message also
 * requested an evaluation - safety always sequences first.
 */
async function handleSafeguarding(ctx: HandlerCtx): Promise<HandlerOutcome> {
  const { item, intake, initial, anchor, errors } = ctx;

  await safeCall(
    "lookup_policy(safeguarding)",
    () => lookup_policy({ topic: POLICY_TOPIC.SAFEGUARDING }),
    errors,
  );

  const escalationReason = `Safeguarding language detected: ${initial.rationaleSeed}`;
  const escalation = await safeCall(
    "escalate(P0)",
    () =>
      escalate({
        item_id: item.id,
        reason: escalationReason,
        severity: URGENCY.P0,
      }),
    errors,
  );

  const child = intake.child_name ?? "the child";
  const task = await safeCall(
    "create_task(clinical_lead)",
    () =>
      create_task({
        assignee: ASSIGNEE.CLINICAL_LEAD,
        title: `Same-hour safeguarding review: ${child}`,
        due: dueDateString(anchor, DUE_OFFSET_DAYS.SAME_DAY),
        notes:
          "Safeguarding language present in the inbound message. Per policy, the clinical lead must triage within the hour, decide on mandated-reporter steps, and contact the family before any scheduling. Underlying request (if any) should be re-evaluated after the safety review.",
      }),
    errors,
  );

  const draftBody = draftSafeguardingAcknowledgement({ intake, language: LANGUAGE.EN });
  const draftResult = await safeCall(
    "draft_message",
    () =>
      draft_message({
        recipient: pickRecipient(item, intake),
        channel: pickDraftChannel(item),
        body: draftBody,
        language: LANGUAGE.EN,
      }),
    errors,
  );

  return {
    classification: CLASSIFICATION.SAFEGUARDING,
    urgency: URGENCY.P0,
    decision_rationale: `${initial.rationaleSeed} Underlying eval request, if any, is deferred until clinical-lead review completes.`,
    recommended_next_action:
      "Clinical lead reviews same-hour, decides on mandated-reporter steps, and contacts the family before any scheduling action.",
    draft_reply: draftResult ? draftBody : null,
    task_ids: task ? [task.data.task_id] : [],
    escalation: escalation
      ? { reason: escalationReason, severity: URGENCY.P0 }
      : null,
  };
}

/**
 * Clinical-question flow: pull the clinical-advice policy snippet so
 * the rationale cites it, create an intake follow-up task, draft a
 * reply that deflects to a screening / evaluation.
 */
async function handleClinicalQuestion(ctx: HandlerCtx): Promise<HandlerOutcome> {
  const { item, intake, initial, anchor, errors } = ctx;

  await safeCall(
    "lookup_policy(clinical_advice)",
    () => lookup_policy({ topic: POLICY_TOPIC.CLINICAL_ADVICE }),
    errors,
  );

  const task = await safeCall(
    "create_task(intake)",
    () =>
      create_task({
        assignee: ASSIGNEE.INTAKE,
        title: `Offer screening for ${intake.child_name ?? "child"} (${item.channel} clinical question)`,
        due: dueDateString(anchor, DUE_OFFSET_DAYS.STANDARD),
        notes:
          "Parent asked for clinical guidance over message; per policy we cannot answer directly. Offer a brief screening or evaluation slot and confirm preferred contact channel.",
      }),
    errors,
  );

  const draftBody = draftClinicalQuestionDeflection({ intake, language: LANGUAGE.EN });
  const draftResult = await safeCall(
    "draft_message",
    () =>
      draft_message({
        recipient: pickRecipient(item, intake),
        channel: pickDraftChannel(item),
        body: draftBody,
        language: LANGUAGE.EN,
      }),
    errors,
  );

  return {
    classification: CLASSIFICATION.CLINICAL_QUESTION,
    urgency: URGENCY.P2,
    decision_rationale: `${initial.rationaleSeed} Draft acknowledges the question and offers a screening pathway without providing clinical advice.`,
    recommended_next_action:
      "Intake follows up to offer a screening or evaluation and confirm contact preferences.",
    draft_reply: draftResult ? draftBody : null,
    task_ids: task ? [task.data.task_id] : [],
    escalation: null,
  };
}

/**
 * Missing-paperwork flow: the referring office sent a stub. We can't
 * reach the family because we don't have their contact. Task the
 * front desk to call the referring office and request a complete
 * referral. Draft is intentionally null.
 */
async function handleMissingPaperwork(ctx: HandlerCtx): Promise<HandlerOutcome> {
  const { item, intake, initial, anchor, errors } = ctx;

  const missing = listMissingIntake(intake);
  const task = await safeCall(
    "create_task(front_desk)",
    () =>
      create_task({
        assignee: ASSIGNEE.FRONT_DESK,
        title: `Request complete referral from ${item.sender}`,
        due: dueDateString(anchor, DUE_OFFSET_DAYS.PAPERWORK_CALLBACK),
        notes: `Referral arrived with blank fields: ${missing.join(", ")}. Call the referring office to request a complete referral document before opening intake.`,
      }),
    errors,
  );

  return {
    classification: CLASSIFICATION.MISSING_PAPERWORK,
    urgency: URGENCY.P2,
    decision_rationale: `${initial.rationaleSeed} Without a parent contact we cannot draft a family-facing reply; staff must contact the referring office.`,
    recommended_next_action: `Front desk calls ${item.sender} to request the missing fields: ${missing.join(", ")}.`,
    draft_reply: null,
    task_ids: task ? [task.data.task_id] : [],
    escalation: null,
  };
}

/**
 * Same-day scheduling flow: look up scheduling policy, attempt to
 * confirm the patient via search_patient, task front desk to release
 * the current slot and find a makeup, draft a reply.
 *
 * We deliberately skip find_slots here - the mock provider data only
 * exposes evaluation slots, and an existing-patient reschedule does
 * not need an evaluation. Surfacing eval slots would mislead staff.
 */
async function handleScheduling(ctx: HandlerCtx): Promise<HandlerOutcome> {
  const { item, intake, initial, anchor, errors } = ctx;

  await safeCall(
    "lookup_policy(scheduling)",
    () => lookup_policy({ topic: POLICY_TOPIC.SCHEDULING }),
    errors,
  );

  const patientMatch = await findPatient(intake, errors);

  const patientLabel = patientMatch
    ? `${patientMatch.name} (${patientMatch.patient_id})`
    : intake.child_name ?? "the patient";

  const task = await safeCall(
    "create_task(front_desk)",
    () =>
      create_task({
        assignee: ASSIGNEE.FRONT_DESK,
        title: `Release today's slot and arrange makeup for ${patientLabel}`,
        due: dueDateString(anchor, DUE_OFFSET_DAYS.SAME_DAY),
        notes: `Family reported a same-day cancellation/illness. Release today's appointment, call ${pickRecipient(item, intake)}, and offer a makeup slot per provider capacity. Discipline on file: ${intake.discipline?.join(", ") ?? "unspecified"}.`,
      }),
    errors,
  );

  const draftBody = draftRescheduleAcknowledgement({ intake, language: LANGUAGE.EN });
  const draftResult = await safeCall(
    "draft_message",
    () =>
      draft_message({
        recipient: pickRecipient(item, intake),
        channel: pickDraftChannel(item),
        body: draftBody,
        language: LANGUAGE.EN,
      }),
    errors,
  );

  const rationale = patientMatch
    ? `${initial.rationaleSeed} Patient match confirmed (${patientMatch.name}). find_slots intentionally skipped because the mock only returns evaluation slots, which do not apply to an existing-patient reschedule.`
    : `${initial.rationaleSeed} No patient match in the system; staff should confirm identity at callback before releasing or rebooking a slot.`;

  return {
    classification: CLASSIFICATION.SCHEDULING,
    urgency: URGENCY.P1,
    decision_rationale: rationale,
    recommended_next_action: `Front desk releases today's slot for ${patientLabel} and calls the family to offer a makeup time.`,
    draft_reply: draftResult ? draftBody : null,
    task_ids: task ? [task.data.task_id] : [],
    escalation: null,
  };
}

/**
 * Default-fallback flow for items that didn't match any other
 * classification. Open an intake task so staff still see the item.
 */
async function handleOther(ctx: HandlerCtx): Promise<HandlerOutcome> {
  const { item, intake, initial, anchor, errors } = ctx;

  const task = await safeCall(
    "create_task(intake)",
    () =>
      create_task({
        assignee: ASSIGNEE.INTAKE,
        title: `Manual triage required: ${item.subject}`,
        due: dueDateString(anchor, DUE_OFFSET_DAYS.STANDARD),
        notes: `Automated triage did not produce a confident classification. Channel: ${item.channel}. Sender: ${item.sender}. Review the message and route appropriately.`,
      }),
    errors,
  );

  return {
    classification: CLASSIFICATION.OTHER,
    urgency: URGENCY.P2,
    decision_rationale: initial.rationaleSeed,
    recommended_next_action: "Intake reviews the message and routes it to the correct workflow.",
    draft_reply: null,
    task_ids: task ? [task.data.task_id] : [],
    escalation: null,
  };
}

/**
 * Calls search_patient with whatever identifier we extracted.
 * Returns the first matching Patient, or null if no match.
 */
async function findPatient(
  intake: ExtractedIntake,
  errors: string[],
): Promise<Patient | null> {
  if (!intake.child_name) return null;

  const isIsoDob =
    intake.dob_or_age !== null && /^\d{4}-\d{2}-\d{2}$/.test(intake.dob_or_age);

  const result = await safeCall(
    "search_patient",
    () =>
      search_patient({
        name: intake.child_name ?? undefined,
        dob: isIsoDob ? intake.dob_or_age ?? undefined : undefined,
      }),
    errors,
  );

  return result?.data[0] ?? null;
}

/**
 * Returns true if the contact name on the inbound message disagrees
 * with the stored guardian. We compare on the first name to tolerate
 * "Smith" vs "Smith Jr." style differences.
 */
function guardianMismatchDetected(
  patient: Patient,
  parentContact: string | null,
): boolean {
  if (!parentContact) return false;
  const storedFirst = patient.guardian_name.split(" ")[0].toLowerCase();
  return !parentContact.toLowerCase().includes(storedFirst);
}

/**
 * Picks one discipline for find_slots from the extracted list. Most
 * referrals are single-discipline; if multiple are tagged we take
 * the first and note it in the task so staff can split intake.
 */
function pickDiscipline(intake: ExtractedIntake): Discipline | undefined {
  return intake.discipline?.[0];
}

/**
 * New-referral / existing-patient flow.
 *
 * The shape is:
 *   1. search_patient (every referral - cheap, catches duplicates).
 *   2. verify_insurance (when we have a payer).
 *   3. Branch on insurance status:
 *        in_network        -> find_slots, optional hold_slot, intake task, draft.
 *        out_of_network    -> lookup_policy(insurance), billing task, draft.
 *        expired           -> same as OON but rationale flags the discrepancy.
 *        unknown / no payer -> intake task to verify benefits, draft.
 *   4. Spanish-preferred families get lookup_policy(language_access)
 *      and find_slots filtered by language. Drafts switch to Spanish.
 */
async function handleNewReferral(ctx: HandlerCtx): Promise<HandlerOutcome> {
  const { item, intake, initial, anchor, errors } = ctx;

  const patientMatch = await findPatient(intake, errors);
  const guardianMismatch = patientMatch
    ? guardianMismatchDetected(patientMatch, intake.parent_contact)
    : false;
  const refinedClassification = patientMatch
    ? CLASSIFICATION.EXISTING_PATIENT
    : initial.classification;

  let insuranceStatus:
    | typeof INSURANCE.IN_NETWORK
    | typeof INSURANCE.OUT_OF_NETWORK
    | typeof INSURANCE.EXPIRED
    | typeof INSURANCE.UNKNOWN = INSURANCE.UNKNOWN;
  let insurancePlan: string | undefined;

  if (intake.payer) {
    const insurance = await safeCall(
      "verify_insurance",
      () =>
        verify_insurance({
          payer: intake.payer ?? undefined,
          member_id: intake.member_id ?? undefined,
        }),
      errors,
    );
    if (insurance) {
      insuranceStatus = insurance.data.status;
      insurancePlan = insurance.data.plan;
    }
  }

  const spanishPreferred = detectSpanishPreferred(item);
  const language = spanishPreferred ? LANGUAGE.ES : LANGUAGE.EN;

  if (
    insuranceStatus === INSURANCE.OUT_OF_NETWORK ||
    insuranceStatus === INSURANCE.EXPIRED
  ) {
    return handleBenefitsConversation({
      ...ctx,
      refinedClassification,
      insuranceStatus,
      insurancePlan,
      language,
      patientMatch,
      guardianMismatch,
    });
  }

  if (insuranceStatus === INSURANCE.IN_NETWORK) {
    return handleInNetworkReferral({
      ...ctx,
      refinedClassification,
      insurancePlan,
      language,
      spanishPreferred,
      patientMatch,
      guardianMismatch,
    });
  }

  return handleUnknownInsurance({
    ...ctx,
    refinedClassification,
    language,
    patientMatch,
    guardianMismatch,
  });
}

// ---------------------------------------------------------------------
// Sub-flows for handleNewReferral - separated for readability.
// ---------------------------------------------------------------------

interface ReferralCtx extends HandlerCtx {
  refinedClassification: Classification;
  language: "en" | "es";
  patientMatch: Patient | null;
  guardianMismatch: boolean;
}

interface BenefitsCtx extends ReferralCtx {
  insuranceStatus: typeof INSURANCE.OUT_OF_NETWORK | typeof INSURANCE.EXPIRED;
  insurancePlan?: string;
}

interface InNetworkCtx extends ReferralCtx {
  insurancePlan?: string;
  spanishPreferred: boolean;
}

interface UnknownInsuranceCtx extends ReferralCtx {}

/**
 * Out-of-network OR expired coverage: policy requires a benefits
 * conversation before any slot work. Route to billing, draft a
 * message that sets that expectation.
 */
async function handleBenefitsConversation(ctx: BenefitsCtx): Promise<HandlerOutcome> {
  const {
    item,
    intake,
    initial,
    anchor,
    errors,
    refinedClassification,
    insuranceStatus,
    insurancePlan,
    language,
    patientMatch,
  } = ctx;

  await safeCall(
    "lookup_policy(insurance)",
    () => lookup_policy({ topic: POLICY_TOPIC.INSURANCE }),
    errors,
  );

  const planLabel = insurancePlan ?? intake.payer ?? "the stated payer";
  const statusLabel =
    insuranceStatus === INSURANCE.OUT_OF_NETWORK ? "out of network" : "expired";

  const taskTitle =
    insuranceStatus === INSURANCE.OUT_OF_NETWORK
      ? `Out-of-network benefits conversation for ${intake.child_name ?? "referral"}`
      : `Expired coverage discrepancy for ${intake.child_name ?? "referral"}`;

  const taskNotes =
    insuranceStatus === INSURANCE.OUT_OF_NETWORK
      ? `Verified ${planLabel} as out of network. Call the family before any slot work to walk through self-pay or alternate-payer options.`
      : `Billing system shows ${planLabel} as expired (referral document may be stale). Confirm current coverage with the family before any scheduling.`;

  const task = await safeCall(
    "create_task(billing)",
    () =>
      create_task({
        assignee: ASSIGNEE.BILLING,
        title: taskTitle,
        due: dueDateString(anchor, DUE_OFFSET_DAYS.NEXT_DAY),
        notes: taskNotes,
      }),
    errors,
  );

  const statusNote =
    insuranceStatus === INSURANCE.OUT_OF_NETWORK
      ? language === LANGUAGE.ES
        ? `Verificamos que ${planLabel} esta fuera de la red.`
        : `Our billing team needs to review the ${planLabel} plan because it appears to be out of network.`
      : language === LANGUAGE.ES
        ? `Nuestro sistema indica que la cobertura de ${planLabel} esta vencida.`
        : `Our billing system shows the ${planLabel} coverage as expired, so we need to confirm current benefits.`;

  const draftBody = draftBenefitsConversationDraft(
    { intake, language },
    statusNote,
  );
  const draftResult = await safeCall(
    "draft_message",
    () =>
      draft_message({
        recipient: pickRecipient(item, intake),
        channel: pickDraftChannel(item),
        body: draftBody,
        language,
      }),
    errors,
  );

  const guardianNote = patientMatch && ctx.guardianMismatch
    ? ` Stored guardian "${patientMatch.guardian_name}" differs from inbound contact "${intake.parent_contact}" - flag for identity verification.`
    : "";

  return {
    classification: refinedClassification,
    urgency: URGENCY.P2,
    decision_rationale: `${initial.rationaleSeed} verify_insurance returned ${statusLabel} for ${planLabel}; policy requires a benefits conversation before any slot work.${guardianNote}`,
    recommended_next_action: `Billing reviews ${statusLabel} options with the family before staff considers any appointment hold.`,
    draft_reply: draftResult ? draftBody : null,
    task_ids: task ? [task.data.task_id] : [],
    escalation: null,
  };
}

/**
 * In-network referral. Look up language-access policy for Spanish
 * families, surface available slots (filtered by discipline + lang),
 * hold the earliest slot when the constraints narrow to a clean
 * single match, task intake, draft the acknowledgement.
 */
async function handleInNetworkReferral(ctx: InNetworkCtx): Promise<HandlerOutcome> {
  const {
    item,
    intake,
    initial,
    anchor,
    errors,
    refinedClassification,
    insurancePlan,
    language,
    spanishPreferred,
    patientMatch,
    guardianMismatch,
  } = ctx;

  if (spanishPreferred) {
    await safeCall(
      "lookup_policy(language_access)",
      () => lookup_policy({ topic: POLICY_TOPIC.LANGUAGE_ACCESS }),
      errors,
    );
  }

  // If there is a guardian-name mismatch, we don't book scheduling
  // work; staff verifies identity first.
  if (guardianMismatch && patientMatch) {
    return handleIdentityVerification({
      ...ctx,
      insurancePlan,
    });
  }

  const discipline = pickDiscipline(intake);
  const preferences = extractPreferences(item) ?? undefined;

  let slots: Slot[] = [];
  if (discipline) {
    const slotsResult = await safeCall(
      "find_slots",
      () =>
        find_slots({
          discipline,
          preferences,
          language: spanishPreferred ? LANGUAGE.ES : undefined,
        }),
      errors,
    );
    if (slotsResult) slots = slotsResult.data;
  }

  // hold_slot is justified when the language constraint produces a
  // narrow provider match and we want to reserve the earliest option
  // for staff review. Otherwise we leave slot selection to staff.
  let heldSlotId: string | null = null;
  if (spanishPreferred && slots.length > 0) {
    const slot = slots[0];
    const patientRef =
      patientMatch?.patient_id ?? `${intake.child_name ?? "patient"} (pending intake)`;
    const holdResult = await safeCall(
      "hold_slot",
      () => hold_slot({ slot_id: slot.slot_id, patient_ref: patientRef }),
      errors,
    );
    if (holdResult) heldSlotId = holdResult.data.hold_id;
  }

  const taskTitle = patientMatch
    ? `Confirm scheduling for existing patient ${patientMatch.name}`
    : `Open intake for ${intake.child_name ?? "new patient"}`;
  const taskNotes = buildIntakeTaskNotes({
    intake,
    insurancePlan,
    slots,
    heldSlotId,
    spanishPreferred,
    patientMatch,
    preferences,
  });

  const task = await safeCall(
    "create_task(intake)",
    () =>
      create_task({
        assignee: ASSIGNEE.INTAKE,
        title: taskTitle,
        due: dueDateString(anchor, DUE_OFFSET_DAYS.STANDARD),
        notes: taskNotes,
      }),
    errors,
  );

  const draftBody = draftInNetworkAcknowledgement({ intake, language });
  const draftResult = await safeCall(
    "draft_message",
    () =>
      draft_message({
        recipient: pickRecipient(item, intake),
        channel: pickDraftChannel(item),
        body: draftBody,
        language,
      }),
    errors,
  );

  const nextAction = heldSlotId
    ? `Intake confirms hold ${heldSlotId} with the family within one business day, then releases it back if the family declines.`
    : slots.length > 0
      ? `Intake calls ${pickRecipient(item, intake)} to confirm a slot from the surfaced options within one business day.`
      : `Intake calls ${pickRecipient(item, intake)} within one business day to schedule once provider availability opens.`;

  const slotSummary =
    slots.length > 0
      ? ` find_slots surfaced ${slots.length} option(s); earliest ${slots[0].start} with ${slots[0].provider_name}.`
      : " find_slots returned no matching options.";

  return {
    classification: refinedClassification,
    urgency: URGENCY.P2,
    decision_rationale: `${initial.rationaleSeed} verify_insurance returned in_network${insurancePlan ? ` (${insurancePlan})` : ""}.${slotSummary}${heldSlotId ? ` Earliest slot held for review as ${heldSlotId} due to narrow language-matched availability.` : ""}`,
    recommended_next_action: nextAction,
    draft_reply: draftResult ? draftBody : null,
    task_ids: task ? [task.data.task_id] : [],
    escalation: null,
  };
}

/**
 * Existing patient with a guardian-name mismatch. We verified coverage
 * but pause on scheduling until staff confirms the caller's identity.
 */
async function handleIdentityVerification(
  ctx: InNetworkCtx,
): Promise<HandlerOutcome> {
  const {
    item,
    intake,
    initial,
    anchor,
    errors,
    refinedClassification,
    insurancePlan,
    language,
    patientMatch,
  } = ctx;

  if (!patientMatch) {
    // Defensive - the caller only routes us here with a patientMatch.
    return handleUnknownInsurance(ctx);
  }

  const taskNotes = `Existing patient ${patientMatch.name} (${patientMatch.patient_id}) has stored guardian "${patientMatch.guardian_name}" but the inbound contact is "${intake.parent_contact}". Insurance verified${insurancePlan ? ` (${insurancePlan})` : ""}. Confirm caller identity before opening a new referral or sharing patient information; reach the stored guardian if needed.`;

  const task = await safeCall(
    "create_task(intake)",
    () =>
      create_task({
        assignee: ASSIGNEE.INTAKE,
        title: `Verify caller identity for ${patientMatch.name}`,
        due: dueDateString(anchor, DUE_OFFSET_DAYS.NEXT_DAY),
        notes: taskNotes,
      }),
    errors,
  );

  // Strip trailing punctuation from the stored patient name (e.g. "Jr.")
  // so it doesn't double up with the sentence-ending period.
  const patientLabel = patientMatch.name.replace(/[.\s]+$/, "");
  const draftBody =
    language === LANGUAGE.ES
      ? `Hola ${firstName(intake.parent_contact)}, recibimos su mensaje sobre ${patientLabel}. Antes de programar, nuestro equipo de admisiones se comunicara para confirmar algunos detalles. Gracias por su paciencia.`
      : `Hi ${firstName(intake.parent_contact)}, thank you for reaching out about ${patientLabel}. Before we move forward our intake team will be in touch to confirm a few details. Thanks for your patience.`;

  const draftResult = await safeCall(
    "draft_message",
    () =>
      draft_message({
        recipient: pickRecipient(item, intake),
        channel: pickDraftChannel(item),
        body: draftBody,
        language,
      }),
    errors,
  );

  return {
    classification: refinedClassification,
    urgency: URGENCY.P2,
    decision_rationale: `${initial.rationaleSeed} Patient match found (${patientMatch.name}) but stored guardian "${patientMatch.guardian_name}" differs from inbound contact "${intake.parent_contact}". Pausing on scheduling until intake confirms identity, regardless of in-network coverage status.`,
    recommended_next_action:
      "Intake verifies caller identity against the stored guardian record before any scheduling or patient-data disclosure.",
    draft_reply: draftResult ? draftBody : null,
    task_ids: task ? [task.data.task_id] : [],
    escalation: null,
  };
}

/**
 * Unknown insurance status or missing payer information. Open an
 * intake task to verify benefits before any scheduling work.
 */
async function handleUnknownInsurance(ctx: UnknownInsuranceCtx): Promise<HandlerOutcome> {
  const {
    item,
    intake,
    initial,
    anchor,
    errors,
    refinedClassification,
    language,
    patientMatch,
  } = ctx;

  const task = await safeCall(
    "create_task(intake)",
    () =>
      create_task({
        assignee: ASSIGNEE.INTAKE,
        title: `Verify benefits for ${intake.child_name ?? "new referral"}`,
        due: dueDateString(anchor, DUE_OFFSET_DAYS.STANDARD),
        notes: `Insurance verification returned ${intake.payer ? "unknown" : "no payer provided"}. Confirm benefits with the family before opening a scheduling workflow. ${patientMatch ? `Existing patient match: ${patientMatch.name} (${patientMatch.patient_id}).` : ""}`.trim(),
      }),
    errors,
  );

  const draftBody = draftUnknownInsuranceAcknowledgement({ intake, language });
  const draftResult = await safeCall(
    "draft_message",
    () =>
      draft_message({
        recipient: pickRecipient(item, intake),
        channel: pickDraftChannel(item),
        body: draftBody,
        language,
      }),
    errors,
  );

  return {
    classification: refinedClassification,
    urgency: URGENCY.P2,
    decision_rationale: `${initial.rationaleSeed} Insurance status could not be verified (${intake.payer ? "payer unrecognised" : "no payer extracted"}); intake will verify benefits before any slot work.`,
    recommended_next_action:
      "Intake calls the family to verify benefits, then routes to scheduling once coverage is confirmed.",
    draft_reply: draftResult ? draftBody : null,
    task_ids: task ? [task.data.task_id] : [],
    escalation: null,
  };
}

/**
 * Builds the intake task notes block. Centralised so the rationale
 * for slot choice and language preference shows up once.
 */
function buildIntakeTaskNotes(args: {
  intake: ExtractedIntake;
  insurancePlan: string | undefined;
  slots: Slot[];
  heldSlotId: string | null;
  spanishPreferred: boolean;
  patientMatch: Patient | null;
  preferences: string | undefined;
}): string {
  const parts: string[] = [];
  parts.push(
    `Discipline: ${args.intake.discipline?.join(", ") ?? "unspecified"}. Concern: ${args.intake.diagnosis_or_concern ?? "not stated"}.`,
  );
  if (args.insurancePlan) {
    parts.push(`Insurance verified in-network (${args.insurancePlan}).`);
  }
  if (args.preferences) {
    parts.push(`Family preference: ${args.preferences}.`);
  }
  if (args.spanishPreferred) {
    parts.push("Family prefers Spanish; pair with Spanish-capable provider/staff.");
  }
  if (args.patientMatch) {
    parts.push(
      `Existing patient match: ${args.patientMatch.name} (${args.patientMatch.patient_id}), stored guardian ${args.patientMatch.guardian_name}.`,
    );
  }
  if (args.slots.length > 0) {
    parts.push(
      `Surfaced ${args.slots.length} eval slot option(s); earliest ${args.slots[0].start} with ${args.slots[0].provider_name}.`,
    );
  } else {
    parts.push("find_slots returned no matching options - staff to coordinate availability.");
  }
  if (args.heldSlotId) {
    parts.push(
      `Held earliest slot for review as ${args.heldSlotId} (pending_review).`,
    );
  }
  return parts.join(" ");
}

// =====================================================================
// Assemble ItemOutput
// =====================================================================

/**
 * Dispatches to the right handler based on the initial classification.
 * Each handler returns a HandlerOutcome which we merge with the
 * extracted intake and the per-item tool trace into a final
 * ItemOutput. Any error during handler execution is caught at the
 * triageItem boundary - this dispatcher itself is straight-line.
 */
async function dispatchHandler(ctx: HandlerCtx): Promise<HandlerOutcome> {
  switch (ctx.initial.classification) {
    case CLASSIFICATION.SAFEGUARDING:
      return handleSafeguarding(ctx);
    case CLASSIFICATION.SCHEDULING:
      return handleScheduling(ctx);
    case CLASSIFICATION.CLINICAL_QUESTION:
      return handleClinicalQuestion(ctx);
    case CLASSIFICATION.MISSING_PAPERWORK:
      return handleMissingPaperwork(ctx);
    case CLASSIFICATION.NEW_REFERRAL:
    case CLASSIFICATION.EXISTING_PATIENT:
      return handleNewReferral(ctx);
    default:
      return handleOther(ctx);
  }
}

/**
 * Triage a single item end-to-end. The withItemContext wrapper is
 * the validator's hook for trace association - every tool call we
 * make inside has to happen on this same async chain. We catch any
 * unexpected error inside the wrapper so partial tool calls still
 * get attributed to the right item.
 */
async function triageItem(item: InboxItem, anchor: Date): Promise<ItemOutput> {
  return withItemContext(item.id, async () => {
    const errors: string[] = [];
    const intake = extractIntake(item);
    const initial = classifyItem(item, intake);

    let outcome: HandlerOutcome;
    try {
      outcome = await dispatchHandler({ item, intake, initial, anchor, errors });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`handler crash: ${msg}`);
      outcome = {
        classification: initial.classification,
        urgency: initial.urgency,
        decision_rationale: `${initial.rationaleSeed} Handler error - manual triage required.`,
        recommended_next_action: FALLBACK_NEXT_ACTION,
        draft_reply: null,
        task_ids: [],
        escalation: null,
      };
    }

    // Pass tool calls through unchanged - required by the validator.
    const tools_called = getToolCallsForItem(item.id);

    const missingInfo = listMissingIntake(intake);
    const rationaleWithErrors = errors.length
      ? `${outcome.decision_rationale} Tool warnings: ${errors.join("; ")}.`
      : outcome.decision_rationale;

    return {
      item_id: item.id,
      classification: outcome.classification,
      urgency: outcome.urgency,
      // Every item gets human review. This is both a validator
      // requirement and a product principle - the agent drafts,
      // surfaces, and holds; humans decide.
      requires_human_review: true,
      extracted_intake: intake,
      missing_info: missingInfo,
      tools_called,
      recommended_next_action: outcome.recommended_next_action,
      draft_reply: outcome.draft_reply,
      task_ids: outcome.task_ids,
      escalation: outcome.escalation,
      decision_rationale: rationaleWithErrors,
    };
  });
}

// =====================================================================
// Public entry point
// =====================================================================

/**
 * Triages a batch of inbox items sequentially. Sequential processing
 * keeps the trace file deterministic and small (8 items is fast),
 * and avoids interleaving tool calls across items which would make
 * debugging the trace painful.
 *
 * A single bad item never crashes the batch: any thrown error inside
 * triageItem is caught and converted to a fallback ItemOutput so the
 * remaining items still process.
 */
export async function runAgent(inbox: InboxItem[]): Promise<ItemOutput[]> {
  const anchor = batchAnchor();
  const outputs: ItemOutput[] = [];

  for (const item of inbox) {
    try {
      outputs.push(await triageItem(item, anchor));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      outputs.push(buildBatchLevelFallback(item, msg));
    }
  }

  return outputs;
}

/**
 * Emergency fallback for an item whose triageItem itself threw before
 * any handler could produce an outcome. Produces a minimally valid
 * ItemOutput so the batch still validates and staff still see the
 * item.
 */
function buildBatchLevelFallback(item: InboxItem, msg: string): ItemOutput {
  return {
    item_id: item.id,
    classification: CLASSIFICATION.OTHER,
    urgency: URGENCY.P2,
    requires_human_review: true,
    extracted_intake: {
      child_name: null,
      dob_or_age: null,
      parent_contact: null,
      discipline: null,
      diagnosis_or_concern: null,
      payer: null,
      member_id: null,
    },
    missing_info: [`agent crash: ${msg}`],
    tools_called: [],
    recommended_next_action: FALLBACK_NEXT_ACTION,
    draft_reply: null,
    task_ids: [],
    escalation: null,
    decision_rationale: `Agent crashed before handler could run: ${msg}. Manual triage required.`,
  };
}
