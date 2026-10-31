import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  conductor,
  assistantText,
  inputMessageId,
  workspaceName,
} from "./lib/conductor";
import { archiveInProgressOrDone } from "./validators";
import { makeBrief } from "./lib/recipes";
import { stableUuid } from "./lib/security";
import { chunks, postSlack, updateWorkspaceMessage } from "./lib/slack";

export const createWorkspace = internalAction({
  args: { runId: v.id("runs") },
  returns: v.null(),
  handler: async (ctx, { runId }) => {
    const run = await ctx.runQuery(internal.runs.get, { runId });
    if (run.workspaceId || archiveInProgressOrDone(run.status)) return null;
    const result = await conductor.create(
      run.projectId,
      workspaceName(run.title),
    );
    await ctx.runMutation(internal.runs.attach, { runId, ...result });
    return null;
  },
});
export const sendInput = internalAction({
  args: { runId: v.id("runs") },
  returns: v.boolean(),
  handler: async (ctx, { runId }): Promise<boolean> => {
    const input = await ctx.runQuery(internal.runs.nextInput, { runId });
    if (!input) return false;
    const run = await ctx.runQuery(internal.runs.get, { runId });
    if (archiveInProgressOrDone(run.status)) return false;
    if (!run.sessionId) throw new Error("Workspace has no session");
    const messageId = await stableUuid(input._id);
    await conductor.send(
      run.sessionId,
      run.awaitingMessageId ? input.text : makeBrief(run.recipe, input.text),
      messageId,
    );
    await ctx.runMutation(internal.runs.sent, {
      inputId: input._id,
      messageId,
    });
    return true;
  },
});
export const notify = internalAction({
  args: {
    runId: v.id("runs"),
    key: v.string(),
    text: v.string(),
    mrkdwn: v.optional(v.boolean()),
    workspaceUrl: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { runId, key, text, mrkdwn, workspaceUrl }) => {
    const run = await ctx.runQuery(internal.runs.get, { runId });
    if (!run.channel || archiveInProgressOrDone(run.status)) return null;
    let threadTs = run.threadTs;
    for (const [index, chunk] of chunks(text).entries()) {
      const partKey = `${key}:${index}`;
      const existing = await ctx.runQuery(internal.runs.output, {
        runId,
        key: partKey,
      });
      if (existing) {
        threadTs ??= existing;
        continue;
      }
      const slackTs = await postSlack(run.channel, chunk, threadTs, {
        mrkdwn,
        runId,
        workspaceUrl: index === 0 ? workspaceUrl : undefined,
      });
      await ctx.runMutation(internal.runs.recordOutput, {
        runId,
        key: partKey,
        slackTs,
        root: !threadTs,
      });
      threadTs ??= slackTs;
    }
    return null;
  },
});
export const poll = internalAction({
  args: { runId: v.id("runs") },
  returns: v.object({ done: v.boolean(), more: v.boolean() }),
  handler: async (
    ctx,
    { runId },
  ): Promise<{ done: boolean; more: boolean }> => {
    const run = await ctx.runQuery(internal.runs.get, { runId });
    if (archiveInProgressOrDone(run.status)) return { done: true, more: false };
    if (!run.sessionId) throw new Error("Workspace has no session");
    const status = await conductor.status(run.sessionId);
    if (status.status === "error")
      throw new Error(
        "Conductor agent reported an error; inspect the workspace",
      );
    const page = await conductor.messages(run.sessionId, run.cursor);
    let inputObserved = run.inputObserved ?? false;
    let replyObserved = run.replyObserved ?? false;
    for (const message of page.data) {
      const inputId = inputMessageId(message);
      if (inputId && inputId === run.awaitingMessageId) inputObserved = true;
      const text = assistantText(message);
      if (
        text &&
        (message.type === "agent"
          ? inputId === run.awaitingMessageId
          : inputObserved)
      )
        replyObserved = true;
      if (text)
        await ctx.runAction(internal.actions.notify, {
          runId,
          key: `message:${message.id}`,
          text,
        });
    }
    await ctx.runMutation(internal.runs.progress, {
      runId,
      cursor: page.data.at(-1)?.id,
      working: status.status === "working",
      inputObserved,
      replyObserved,
    });
    // Require a reply after the latest input, not an older turn's unread reply.
    return {
      done: !page.hasMore && status.status === "idle" && replyObserved,
      more: page.hasMore,
    };
  },
});

export const refreshWorkspaceNotice = internalAction({
  args: { runId: v.id("runs") },
  returns: v.null(),
  handler: async (ctx, { runId }) => {
    const run = await ctx.runQuery(internal.runs.get, { runId });
    const ts = await ctx.runQuery(internal.runs.output, {
      runId,
      key: "workspace:0",
    });
    if (run.channel && run.deepLink && ts)
      await updateWorkspaceMessage(
        run.channel,
        ts,
        run.deepLink,
        runId,
        run.status,
      );
    return null;
  },
});

export const archiveWorkspace = internalAction({
  args: { runId: v.id("runs") },
  returns: v.null(),
  handler: async (ctx, { runId }) => {
    const run = await ctx.runQuery(internal.runs.get, { runId });
    if (run.status !== "archiving" || !run.workspaceId) return null;
    try {
      await conductor.archive(run.workspaceId);
    } catch (error) {
      await ctx.runMutation(internal.runs.finishArchive, {
        runId,
        error: error instanceof Error ? error.message : "Archive failed",
      });
      await ctx.runAction(internal.actions.refreshWorkspaceNotice, { runId });
      return null;
    }
    await ctx.runMutation(internal.runs.finishArchive, { runId });
    await ctx.runAction(internal.actions.refreshWorkspaceNotice, { runId });
    return null;
  },
});
