import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { inputFields, runFields } from "./validators";

// These are integration delivery records. Conductor owns the agent conversation.
export default defineSchema({
  runs: defineTable(runFields)
    .index("by_key", ["key"])
    .index("by_teamId_and_channel_and_threadTs", [
      "teamId",
      "channel",
      "threadTs",
    ]),
  inputs: defineTable(inputFields)
    .index("by_key", ["key"])
    .index("by_runId_and_state", ["runId", "state"]),
  outputs: defineTable({
    runId: v.id("runs"),
    key: v.string(),
    slackTs: v.string(),
  }).index("by_runId_and_key", ["runId", "key"]),
});
