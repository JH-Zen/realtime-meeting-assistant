import { z } from "zod";

const Count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Time = z.number().finite().min(0);
export const RecoveryFailureCodeSchema = z.enum(["batch_failed", "incomplete_output", "cancelled", "process_interrupted", "audit_failed", "backlog_full", "invalid_output", "partial_graph"]);
export const RecoveryAttemptSchema = z.object({
  batch: z.number().int().min(1).max(8),
  attempt: z.number().int().min(1).max(3),
  inputCount: Count.refine((n) => n > 0),
  savedCount: Count,
  outcome: z.enum(["running", "succeeded", "incomplete", "failed", "interrupted"]),
  startedAt: Time,
  finishedAt: Time.nullable(),
}).superRefine((value, ctx) => {
  if (value.savedCount > value.inputCount) ctx.addIssue({ code: "custom", message: "Saved count exceeds input" });
  if (value.outcome === "succeeded" && value.savedCount !== value.inputCount) ctx.addIssue({ code: "custom", message: "Success must save all inputs" });
  if ((value.outcome === "running") !== (value.finishedAt === null)) ctx.addIssue({ code: "custom", message: "Attempt finish state mismatch" });
  if (value.finishedAt !== null && value.finishedAt < value.startedAt) ctx.addIssue({ code: "custom", message: "Attempt time is reversed" });
});

/** Operational metadata only. No prompts, model output, meeting text or raw provider errors. */
export const RecoveryTaskSchema = z.object({
  id: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128),
  kind: z.enum(["retrieval", "mindmap"]),
  trigger: z.enum(["manual", "live"]).optional(),
  // Preserve the transcript ID contract; do not truncate long but valid source identifiers.
  sourceSegmentIds: z.array(z.string().min(1)).max(512).optional(),
  status: z.enum(["running", "succeeded", "incomplete", "failed", "interrupted"]),
  startedAt: Time,
  finishedAt: Time.nullable(),
  initialMissing: Count,
  remaining: Count.nullable(),
  completedBatches: z.number().int().min(0).max(8),
  failureCode: RecoveryFailureCodeSchema.nullable(),
  attempts: z.array(RecoveryAttemptSchema).max(24),
}).superRefine((value, ctx) => {
  if ((value.status === "running") !== (value.finishedAt === null)) ctx.addIssue({ code: "custom", message: "Task finish state mismatch" });
  if (value.finishedAt !== null && value.finishedAt < value.startedAt) ctx.addIssue({ code: "custom", message: "Task time is reversed" });
  if (value.status === "succeeded" && (value.remaining !== 0 || value.failureCode !== null)) ctx.addIssue({ code: "custom", message: "Successful task must have zero missing rows and no failure" });
  if (value.completedBatches !== value.attempts.filter((a) => a.outcome === "succeeded").length) ctx.addIssue({ code: "custom", message: "Completed batch count mismatch" });
  if (value.sourceSegmentIds && new Set(value.sourceSegmentIds).size !== value.sourceSegmentIds.length) ctx.addIssue({ code: "custom", message: "Duplicate source IDs" });
  if (value.trigger === "live" && (!value.sourceSegmentIds?.length || value.sourceSegmentIds.length !== value.initialMissing)) ctx.addIssue({ code: "custom", message: "Live source IDs must match the nonempty input batch" });
  const keys = new Set<string>();
  for (const attempt of value.attempts) {
    const key = `${attempt.batch}:${attempt.attempt}`;
    if (keys.has(key)) ctx.addIssue({ code: "custom", message: "Duplicate attempt" });
    keys.add(key);
    if (attempt.startedAt < value.startedAt || (value.finishedAt !== null && (attempt.finishedAt ?? attempt.startedAt) > value.finishedAt)) ctx.addIssue({ code: "custom", message: "Attempt outside task time" });
    if (value.status !== "running" && attempt.outcome === "running") ctx.addIssue({ code: "custom", message: "Finished task has a running attempt" });
  }
});

export type RecoveryAttempt = z.infer<typeof RecoveryAttemptSchema>;
export type RecoveryTask = z.infer<typeof RecoveryTaskSchema>;
export type RecoveryFailureCode = z.infer<typeof RecoveryFailureCodeSchema>;
