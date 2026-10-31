import { v } from "convex/values";

export const runStatus = v.union(
  v.literal("active"),
  v.literal("idle"),
  v.literal("attention"),
);
export const runFields = {
  key: v.string(),
  source: v.union(v.literal("slack"), v.literal("webhook")),
  projectId: v.string(),
  recipe: v.string(),
  title: v.string(),
  channel: v.optional(v.string()),
  threadTs: v.optional(v.string()),
  teamId: v.optional(v.string()),
  status: runStatus,
  workspaceId: v.optional(v.string()),
  sessionId: v.optional(v.string()),
  deepLink: v.optional(v.string()),
  cursor: v.optional(v.string()),
  workflowId: v.optional(v.string()),
  generation: v.number(),
  seenWorking: v.boolean(),
  lastInputAt: v.number(),
  error: v.optional(v.string()),
  awaitingMessageId: v.optional(v.string()),
  inputObserved: v.optional(v.boolean()),
  replyObserved: v.optional(v.boolean()),
};
export const runDoc = v.object({
  _id: v.id("runs"),
  _creationTime: v.number(),
  ...runFields,
});
export const inputFields = {
  runId: v.id("runs"),
  key: v.string(),
  text: v.string(),
  state: v.union(v.literal("pending"), v.literal("sent")),
};
export const inputDoc = v.object({
  _id: v.id("inputs"),
  _creationTime: v.number(),
  ...inputFields,
});
