import { WorkflowManager } from "@convex-dev/workflow";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";

export const workflow = new WorkflowManager(components.workflow, {
  workpoolOptions: { maxParallelism: 5, retryActionsByDefault: false },
});
export const drive = workflow
  .define({
    args: { runId: v.id("runs"), generation: v.number() },
    returns: v.null(),
  })
  .handler(async (step, { runId }): Promise<null> => {
    // Upstream explicitly says creation is NOT idempotent. Never blindly retry it.
    await step.runAction(
      internal.actions.createWorkspace,
      { runId },
      { retry: false },
    );
    const run = await step.runQuery(internal.runs.get, { runId });
    await step.runAction(
      internal.actions.notify,
      {
        runId,
        key: "workspace",
        text: `Open workspace: ${run.deepLink}`,
        workspaceUrl: run.deepLink,
      },
      { retry: false },
    );
    for (let poll = 0; poll < 480; poll++) {
      // A bounded batch keeps input processing from starving progress reporting.
      for (let n = 0; n < 10; n++) {
        const sent = await step.runAction(
          internal.actions.sendInput,
          { runId },
          { retry: { maxAttempts: 4, initialBackoffMs: 1000, base: 2 } },
        );
        if (!sent) break;
      }
      // Poll includes Slack writes; uncertain delivery must not be replayed blindly.
      const state = await step.runAction(
        internal.actions.poll,
        { runId },
        { retry: false, runAfter: poll === 0 ? 1000 : 15000 },
      );
      if (state.done) return null;
    }
    throw new Error(
      "Monitoring limit reached. The Conductor workspace may still be running; inspect it and resume monitoring.",
    );
  });
