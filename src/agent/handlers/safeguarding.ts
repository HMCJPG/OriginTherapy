/**
 * P0 safeguarding flow.
 *
 * Sequence:
 *   1. lookup_policy(safeguarding) - cite the policy.
 *   2. escalate(P0)               - same-hour clinical-lead alert.
 *   3. create_task(clinical_lead) - same-day review task.
 *   4. draft_message              - neutral acknowledgement only.
 *
 * Policy explicitly forbids investigative questions or clinical
 * guidance in the draft, so the template at draftSafeguardingAcknowledgement
 * is intentionally minimal.
 *
 * Any underlying request (e.g. an eval mentioned in the same message)
 * is deferred until clinical lead completes the safety review. We do
 * not call find_slots or hold_slot in this flow.
 */

import {
  create_task,
  draft_message,
  escalate,
  lookup_policy,
} from "../../tools.js";
import { ASSIGNEE, CLASSIFICATION, DUE_OFFSET_DAYS, LANGUAGE, POLICY_TOPIC, URGENCY } from "../constants.js";
import { draftSafeguardingAcknowledgement, pickDraftChannel, pickRecipient } from "../drafts.js";
import { safeCall } from "../safe-call.js";
import { dueDateString } from "../utils.js";
import type { HandlerCtx, HandlerOutcome } from "./shared.js";

export async function handleSafeguarding(ctx: HandlerCtx): Promise<HandlerOutcome> {
  const { item, intake, initial, anchor, errors } = ctx;

  // 1. Anchor the rationale in policy.
  await safeCall(
    "lookup_policy(safeguarding)",
    () => lookup_policy({ topic: POLICY_TOPIC.SAFEGUARDING }),
    errors,
  );

  // 2. Escalate at P0 with the specific phrases that triggered.
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

  // 3. Same-hour review task on the clinical lead's queue.
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

  // 4. Neutral acknowledgement draft - no investigative questions,
  //    no clinical guidance, no implied action.
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
    escalation: escalation ? { reason: escalationReason, severity: URGENCY.P0 } : null,
  };
}
