/**
 * Clinical-question flow.
 *
 * Sequence:
 *   1. lookup_policy(clinical_advice) - cite the policy.
 *   2. create_task(intake)            - intake offers a screening / eval.
 *   3. draft_message                  - acknowledges the question and
 *                                       offers the screening pathway
 *                                       without providing clinical advice.
 */

import { create_task, draft_message, lookup_policy } from "../../tools.js";
import {
  ASSIGNEE,
  CLASSIFICATION,
  DUE_OFFSET_DAYS,
  LANGUAGE,
  POLICY_TOPIC,
  URGENCY,
} from "../constants.js";
import {
  draftClinicalQuestionDeflection,
  pickDraftChannel,
  pickRecipient,
} from "../drafts.js";
import { safeCall } from "../safe-call.js";
import { dueDateString } from "../utils.js";
import type { HandlerCtx, HandlerOutcome } from "./shared.js";

export async function handleClinicalQuestion(ctx: HandlerCtx): Promise<HandlerOutcome> {
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
