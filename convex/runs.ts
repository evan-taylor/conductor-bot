import { v } from "convex/values";
import { type WorkflowId, vWorkflowId } from "@convex-dev/workflow";
import { vResultValidator } from "@convex-dev/workpool";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { archiveInProgressOrDone, runDoc, inputDoc } from "./validators";
import { workflow } from "./workflow";
import { slackAccess } from "./lib/config";

async function launch(ctx: MutationCtx, runId: Id<"runs">, generation: number) {
  const workflowId = await workflow.start(
    ctx,
    internal.workflow.drive,
    { runId, generation },
    {
      onComplete: internal.runs.onComplete,
      context: { runId, generation },
    },
  );
  await ctx.db.patch(runId, {
    workflowId,
    generation,
    status: "active",
    error: undefined,
    seenWorking: false,
  });
}

export const ingest = internalMutation({
  args: {
    key: v.string(),
    runKey: v.string(),
    text: v.string(),
    canCreate: v.boolean(),
    source: v.union(v.literal("slack"), v.literal("webhook")),
    projectId: v.string(),
    recipe: v.string(),
    channel: v.optional(v.string()),
    threadTs: v.optional(v.string()),
    teamId: v.optional(v.string()),
  },
  returns: v.union(v.id("runs"), v.null()),
  handler: async (ctx, args): Promise<Id<"runs"> | null> => {
    const existing = await ctx.db
      .query("inputs")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    if (existing) return existing.runId;
    let run = await ctx.db
      .query("runs")
      .withIndex("by_key", (q) => q.eq("key", args.runKey))
      .unique();
    if (!run && args.source === "slack" && args.threadTs) {
      run = await ctx.db
        .query("runs")
        .withIndex("by_teamId_and_channel_and_threadTs", (q) =>
          q
            .eq("teamId", args.teamId)
            .eq("channel", args.channel)
            .eq("threadTs", args.threadTs),
        )
        .unique();
    }
    if (run && archiveInProgressOrDone(run.status)) return null;
    if (!run && !args.canCreate) return null;
    if (!run) {
      const runId = await ctx.db.insert("runs", {
        key: args.runKey,
        source: args.source,
        projectId: args.projectId,
        recipe: args.recipe,
        title: args.text.slice(0, 100),
        channel: args.channel,
        threadTs: args.threadTs,
        teamId: args.teamId,
        status: "idle",
        generation: 0,
        seenWorking: false,
        lastInputAt: Date.now(),
      });
      run = (await ctx.db.get(runId))!;
    }
    await ctx.db.insert("inputs", {
      runId: run._id,
      key: args.key,
      text: args.text,
      state: "pending",
    });
    await ctx.db.patch(run._id, { lastInputAt: Date.now() });
    if (run.status === "idle") await launch(ctx, run._id, run.generation + 1);
    // Failed/ambiguous runs retain new inputs for explicit operator recovery.
    return run._id;
  },
});

export const get = internalQuery({
  args: { runId: v.id("runs") },
  returns: runDoc,
  handler: async (ctx, { runId }): Promise<Doc<"runs">> => {
    const run = await ctx.db.get(runId);
    if (!run) throw new Error("Run not found");
    return run;
  },
});
export const nextInput = internalQuery({
  args: { runId: v.id("runs") },
  returns: v.union(inputDoc, v.null()),
  handler: async (ctx, { runId }): Promise<Doc<"inputs"> | null> =>
    ctx.db
      .query("inputs")
      .withIndex("by_runId_and_state", (q) =>
        q.eq("runId", runId).eq("state", "pending"),
      )
      .first(),
});
export const attach = internalMutation({
  args: {
    runId: v.id("runs"),
    workspaceId: v.string(),
    sessionId: v.string(),
    deepLink: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { runId, ...data }) => {
    await ctx.db.patch(runId, data);
    return null;
  },
});
export const sent = internalMutation({
  args: { inputId: v.id("inputs"), messageId: v.string() },
  returns: v.null(),
  handler: async (ctx, { inputId, messageId }) => {
    const input = await ctx.db.get(inputId);
    if (!input) throw new Error("Input not found");
    await ctx.db.patch(inputId, { state: "sent" });
    await ctx.db.patch(input.runId, {
      seenWorking: false,
      awaitingMessageId: messageId,
      inputObserved: false,
      replyObserved: false,
    });
    return null;
  },
});
export const progress = internalMutation({
  args: {
    runId: v.id("runs"),
    cursor: v.optional(v.string()),
    working: v.boolean(),
    inputObserved: v.boolean(),
    replyObserved: v.boolean(),
  },
  returns: v.null(),
  handler: async (
    ctx,
    { runId, cursor, working, inputObserved, replyObserved },
  ) => {
    await ctx.db.patch(runId, {
      ...(cursor ? { cursor } : {}),
      ...(working ? { seenWorking: true } : {}),
      inputObserved,
      replyObserved,
    });
    return null;
  },
});
export const output = internalQuery({
  args: { runId: v.id("runs"), key: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { runId, key }): Promise<string | null> => {
    const row = await ctx.db
      .query("outputs")
      .withIndex("by_runId_and_key", (q) => q.eq("runId", runId).eq("key", key))
      .unique();
    return row?.slackTs ?? null;
  },
});
export const recordOutput = internalMutation({
  args: {
    runId: v.id("runs"),
    key: v.string(),
    slackTs: v.string(),
    root: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, { root, ...args }) => {
    const row = await ctx.db
      .query("outputs")
      .withIndex("by_runId_and_key", (q) =>
        q.eq("runId", args.runId).eq("key", args.key),
      )
      .unique();
    if (!row) await ctx.db.insert("outputs", args);
    if (root) await ctx.db.patch(args.runId, { threadTs: args.slackTs });
    return null;
  },
});

// Completion and the pending-input check happen in one transaction, so a reply
// arriving as a workflow finishes cannot be stranded.
export const onComplete = internalMutation({
  args: {
    workflowId: vWorkflowId,
    result: vResultValidator,
    context: v.object({ runId: v.id("runs"), generation: v.number() }),
  },
  returns: v.null(),
  handler: async (ctx, { result, context }) => {
    const run = await ctx.db.get(context.runId);
    if (!run || run.generation !== context.generation) return null;
    if (result.kind !== "success") {
      await ctx.db.patch(run._id, {
        status: "attention",
        error: result.kind === "failed" ? result.error : "Workflow canceled",
      });
      return null;
    }
    const pending = await ctx.db
      .query("inputs")
      .withIndex("by_runId_and_state", (q) =>
        q.eq("runId", run._id).eq("state", "pending"),
      )
      .first();
    if (pending) await launch(ctx, run._id, run.generation + 1);
    else await ctx.db.patch(run._id, { status: "idle" });
    return null;
  },
});

// Dashboard/CLI only: never exposed as a public function.
export const resume = internalMutation({
  args: { runId: v.id("runs") },
  returns: v.null(),
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get(runId);
    if (run && archiveInProgressOrDone(run.status))
      throw new Error("Archived runs cannot be resumed from this thread");
    if (!run || run.status === "active")
      throw new Error("Run missing or already active");
    if (!run.sessionId)
      throw new Error(
        "Reconcile workspace creation and attach the verified workspace before resuming",
      );
    await launch(ctx, runId, run.generation + 1);
    return null;
  },
});

// Replay after adapter upgrades. Existing delivery keys prevent duplicate Slack posts.
export const rewindTranscript = internalMutation({
  args: { runId: v.id("runs") },
  returns: v.null(),
  handler: async (ctx, { runId }) => {
    await ctx.db.patch(runId, {
      cursor: undefined,
      inputObserved: false,
      replyObserved: false,
    });
    return null;
  },
});

export const requestArchive = internalMutation({
  args: {
    runId: v.string(),
    teamId: v.string(),
    userId: v.string(),
    channel: v.string(),
    messageTs: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    if (!slackAccess(args.teamId, args.userId)) return false;
    const runId = ctx.db.normalizeId("runs", args.runId);
    if (!runId) return false;
    const run = await ctx.db.get(runId);
    if (
      !run ||
      !run.workspaceId ||
      run.teamId !== args.teamId ||
      run.channel !== args.channel
    )
      return false;
    const notice = await ctx.db
      .query("outputs")
      .withIndex("by_runId_and_key", (q) =>
        q.eq("runId", runId).eq("key", "workspace:0"),
      )
      .unique();
    if (!notice || notice.slackTs !== args.messageTs) return false;
    if (run.status === "archiving") return true;
    if (run.status === "archived") {
      await ctx.scheduler.runAfter(0, internal.actions.refreshWorkspaceNotice, {
        runId,
      });
      return true;
    }
    await ctx.db.patch(runId, {
      status: "archiving",
      generation: run.generation + 1,
      error: undefined,
    });
    if (run.status === "active" && run.workflowId)
      await workflow.cancel(ctx, run.workflowId as WorkflowId);
    await ctx.scheduler.runAfter(0, internal.actions.archiveWorkspace, {
      runId,
    });
    return true;
  },
});

export const finishArchive = internalMutation({
  args: { runId: v.id("runs"), error: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { runId, error }) => {
    await ctx.db.patch(runId, {
      status: error ? "archive_failed" : "archived",
      error,
    });
    return null;
  },
});
