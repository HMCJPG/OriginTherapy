/**
 * Missing-paperwork flow.
 *
 * The referring office sent a stub - blank DOB, blank parent, etc.
 * We can't reach the family because we don't have their contact, so:
 *
 *   1. create_task(front_desk) - call the referring office for a
 *                                complete referral.
 *   2. draft_reply is intentionally null (no family contact).
 */

import { create_task } from "../../tools.js";
import {
  ASSIGNEE,
  CLASSIFICATION,
  DUE_OFFSET_DAYS,
  URGENCY,
} from "../constants.js";
import { listMissingIntake } from "../extraction.js";
import { safeCall } from "../safe-call.js";
import { dueDateString } from "../utils.js";
import type { HandlerCtx, HandlerOutcome } from "./shared.js";

export async function handleMissingPaperwork(ctx: HandlerCtx): Promise<HandlerOutcome> {
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
