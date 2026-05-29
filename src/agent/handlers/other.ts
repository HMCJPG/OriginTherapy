/**
 * Default-fallback flow for items that didn't match any other
 * classification. Opens an intake task so staff still see the item.
 *
 * This handler exists so the dispatcher in ./index.ts has somewhere
 * to send anything we couldn't classify. If you see real items
 * landing here often, that's a signal to add a new classifier in
 * ../classification.ts.
 */

import { create_task } from "../../tools.js";
import {
  ASSIGNEE,
  CLASSIFICATION,
  DUE_OFFSET_DAYS,
  URGENCY,
} from "../constants.js";
import { safeCall } from "../safe-call.js";
import { dueDateString } from "../utils.js";
import type { HandlerCtx, HandlerOutcome } from "./shared.js";

export async function handleOther(ctx: HandlerCtx): Promise<HandlerOutcome> {
  const { item, initial, anchor, errors } = ctx;

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
