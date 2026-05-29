/**
 * Classification (the decision tree).
 *
 * Pure function that maps an inbox item + its extracted intake onto
 * an initial `(classification, urgency, rationaleSeed)`.
 *
 * Handlers may refine the classification afterwards (e.g.
 * new_referral -> existing_patient_request once search_patient
 * finds a match) but never change the urgency without a clear,
 * named reason.
 *
 * Ordering is significant:
 *   1. Safeguarding is checked FIRST so a safety signal buried
 *      inside an otherwise routine eval request still escalates.
 *   2. P1 same-day scheduling next.
 *   3. P2 paths last.
 *   4. Unknown items fall through to `other` (still P2, still
 *      reviewed by humans).
 *
 * Adding a new classification?
 *   1. Add the constant in ./constants.ts (CLASSIFICATION).
 *   2. Add a detector in ./signals.ts.
 *   3. Add the check here in the right priority slot.
 *   4. Add a handler in ./handlers/.
 *   5. Add the case to ./handlers/index.ts (dispatchHandler).
 */

import { CLASSIFICATION, URGENCY } from "./constants.js";
import {
  detectClinicalQuestion,
  detectIncompleteReferral,
  detectSafeguarding,
  detectScheduling,
  isReferralChannel,
  looksLikeNewIntakeRequest,
} from "./signals.js";
import type { Classification, ExtractedIntake, InboxItem, Urgency } from "../types.js";

/**
 * The initial decision a handler is asked to act on. `rationaleSeed`
 * is the first sentence of `decision_rationale` - handlers append
 * tool-driven detail to it.
 */
export interface InitialDecision {
  classification: Classification;
  urgency: Urgency;
  rationaleSeed: string;
}

/**
 * Classify an item using the priority-ordered decision tree.
 *
 * @param item   The InboxItem under triage.
 * @param intake The extracted intake fields. Pure - no tools called.
 */
export function classifyItem(
  item: InboxItem,
  intake: ExtractedIntake,
): InitialDecision {
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
