/**
 * Handler dispatch.
 *
 * Maps each classification to its handler. The orchestrator in
 * src/agent.ts calls this once per item. Every handler returns the
 * same HandlerOutcome shape so the orchestrator can stay generic.
 *
 * Adding a new classification?
 *   1. Add the constant in ../constants.ts.
 *   2. Add a detector in ../signals.ts.
 *   3. Add the check in ../classification.ts.
 *   4. Add a handler file here in ./handlers/.
 *   5. Add the case below.
 */

import { CLASSIFICATION } from "../constants.js";
import { handleClinicalQuestion } from "./clinical-question.js";
import { handleMissingPaperwork } from "./missing-paperwork.js";
import { handleNewReferral } from "./new-referral.js";
import { handleOther } from "./other.js";
import { handleSafeguarding } from "./safeguarding.js";
import { handleScheduling } from "./scheduling.js";
import type { HandlerCtx, HandlerOutcome } from "./shared.js";

export type { HandlerCtx, HandlerOutcome } from "./shared.js";

/** Dispatch a triage context to the matching handler. */
export async function dispatchHandler(ctx: HandlerCtx): Promise<HandlerOutcome> {
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
