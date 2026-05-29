/**
 * Signal detectors.
 *
 * Pure functions over an InboxItem (and optional ExtractedIntake).
 * Each one returns either a boolean or a small structured "hit"
 * object - they never call tools. Tools are reserved for verification
 * (insurance lookup, patient lookup) once a signal has been detected.
 *
 * Detectors live in their own module so adding a new triage signal
 * (e.g. complaint detection) is a one-file edit, separate from the
 * classifier that decides which signal wins.
 */

import {
  CHANNEL,
  CLINICAL_QUESTION_MARKERS,
  RESCHEDULE_KEYWORDS,
  SAFEGUARDING_KEYWORDS,
  SPANISH_PHRASE_INDICATORS,
} from "./constants.js";
import { searchableText } from "./utils.js";
import type { ExtractedIntake, InboxItem } from "../types.js";

/**
 * Returns whether any safeguarding language appears and which
 * specific phrases matched. The phrase list is reported so the
 * rationale can quote it back to reviewers.
 */
export function detectSafeguarding(item: InboxItem): {
  hit: boolean;
  phrases: string[];
} {
  const text = searchableText(item);
  const phrases = SAFEGUARDING_KEYWORDS.filter((kw) => text.includes(kw));
  return { hit: phrases.length > 0, phrases };
}

/**
 * Clinical-question detector. Restricted to portal and email
 * channels because a parent voicemail asking "is this normal" is
 * usually a triage request that needs a callback, not a deflection.
 *
 * If the message ALSO mentions a "referral", we let the referral
 * flow win (item_4-style cases) instead of treating it as a
 * clinical-question deflection.
 */
export function detectClinicalQuestion(item: InboxItem): boolean {
  const isInquiryChannel =
    item.channel === CHANNEL.PORTAL || item.channel === CHANNEL.EMAIL;
  if (!isInquiryChannel) return false;

  const text = searchableText(item);
  const hasMarker = CLINICAL_QUESTION_MARKERS.some((m) => text.includes(m));
  const looksLikeReferral = /referral/.test(text);

  return hasMarker && !looksLikeReferral;
}

/** Detects same-day cancellation, reschedule, or no-show language. */
export function detectScheduling(item: InboxItem): boolean {
  const text = searchableText(item);
  return RESCHEDULE_KEYWORDS.some((kw) => text.includes(kw));
}

/**
 * True when the family appears to communicate primarily in Spanish.
 *
 * We require either the literal word "espanol/español" OR two-plus
 * Spanish phrase markers to avoid false positives on emails that
 * happen to contain a single Spanish word.
 */
export function detectSpanishPreferred(item: InboxItem): boolean {
  const text = searchableText(item);
  if (/espa[nñ]ol/.test(text)) return true;
  const hits = SPANISH_PHRASE_INDICATORS.filter((p) => text.includes(p));
  return hits.length >= 2;
}

/** True if the channel is one we treat as a structured referral document. */
export function isReferralChannel(item: InboxItem): boolean {
  return item.channel === CHANNEL.FAX;
}

/**
 * True when a fax referral has two-plus required intake fields blank.
 * Used to route item_6-style stubs to the missing-paperwork flow
 * instead of the standard intake flow.
 */
export function detectIncompleteReferral(
  item: InboxItem,
  intake: ExtractedIntake,
): boolean {
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
 * request without being on the structured fax channel. Includes
 * Spanish equivalents so Spanish-language requests still match.
 */
export function looksLikeNewIntakeRequest(
  item: InboxItem,
  intake: ExtractedIntake,
): boolean {
  const text = searchableText(item);
  const mentionsCare =
    /referral|evaluation|evaluac[ií]on|\beval\b|screening|therapy|terapia|habla|speech/.test(
      text,
    );
  return mentionsCare && intake.child_name !== null;
}
