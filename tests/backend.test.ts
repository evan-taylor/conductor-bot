import { convexTest } from "convex-test";
import workflowTest from "@convex-dev/workflow/test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";

const modules = import.meta.glob("../convex/**/*.ts");
function backend() {
  const t = convexTest(schema, modules);
  workflowTest.register(t);
  return t;
}
const input = {
  key: "slack:T1:C1:1",
  runKey: "slack:T1:C1:1",
  text: "Fix the bug",
  canCreate: true,
  source: "slack" as const,
  projectId: "p1",
  recipe: "coding",
  teamId: "T1",
  channel: "C1",
  threadTs: "1",
};
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("deduplicates deliveries transactionally and queues follow-up messages in one run", async () => {
  const t = backend();
  const id = await t.mutation(internal.runs.ingest, input);
  expect(await t.mutation(internal.runs.ingest, input)).toBe(id);
  expect(
    await t.mutation(internal.runs.ingest, {
      ...input,
      key: "slack:T1:C1:2",
      text: "Also add a regression test",
      canCreate: false,
    }),
  ).toBe(id);
  const rows = await t.run((ctx) => ctx.db.query("inputs").take(10));
  expect(rows).toHaveLength(2);
  expect((await t.query(internal.runs.get, { runId: id! })).generation).toBe(1);
});

it("ignores unbound channel messages without consuming a later mention", async () => {
  const t = backend();
  expect(
    await t.mutation(internal.runs.ingest, { ...input, canCreate: false }),
  ).toBeNull();
  expect(await t.mutation(internal.runs.ingest, input)).not.toBeNull();
});

it("routes replies to automation-created threads", async () => {
  const t = backend();
  const id = await t.mutation(internal.runs.ingest, {
    ...input,
    source: "webhook",
    key: "webhook:sentry:issue1",
    runKey: "webhook:sentry:issue1",
    threadTs: undefined,
  });
  await t.mutation(internal.runs.recordOutput, {
    runId: id!,
    key: "workspace:0",
    slackTs: "200",
    root: true,
  });
  expect(
    await t.mutation(internal.runs.ingest, {
      ...input,
      key: "slack:T1:C1:201",
      runKey: "slack:T1:C1:200",
      threadTs: "200",
      canCreate: false,
    }),
  ).toBe(id);
});

it("does not recreate an attached workspace and reuses message IDs across uncertain sends", async () => {
  const t = backend();
  const id = (await t.mutation(internal.runs.ingest, input))!;
  await t.mutation(internal.runs.attach, {
    runId: id,
    workspaceId: "w1",
    sessionId: "s1",
    deepLink: "conductor://w1",
  });
  vi.stubEnv("CONDUCTOR_API_KEY", "test-only");
  const fetchMock = vi
    .fn()
    .mockRejectedValueOnce(new Error("response lost"))
    .mockResolvedValueOnce(Response.json({}));
  vi.stubGlobal("fetch", fetchMock);
  await t.action(internal.actions.createWorkspace, { runId: id });
  expect(fetchMock).not.toHaveBeenCalled();
  await expect(
    t.action(internal.actions.sendInput, { runId: id }),
  ).rejects.toThrow("response lost");
  await t.action(internal.actions.sendInput, { runId: id });
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).messageId).toBe(
    JSON.parse(fetchMock.mock.calls[1][1].body).messageId,
  );
  expect(await t.query(internal.runs.nextInput, { runId: id })).toBeNull();
});

it("does not consider initial idle to be task completion", async () => {
  const t = backend();
  const id = (await t.mutation(internal.runs.ingest, input))!;
  await t.mutation(internal.runs.attach, {
    runId: id,
    workspaceId: "w1",
    sessionId: "s1",
    deepLink: "conductor://w1",
  });
  vi.stubEnv("CONDUCTOR_API_KEY", "test-only");
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(Response.json({ status: "idle" }))
      .mockResolvedValueOnce(Response.json({ data: [], hasMore: false })),
  );
  expect(await t.action(internal.actions.poll, { runId: id })).toEqual({
    done: false,
    more: false,
  });
});

it("rejects unauthenticated webhooks before creating any runs", async () => {
  const t = backend();
  vi.stubEnv("AUTOMATION_WEBHOOK_SECRET", "test-secret");
  expect(
    (await t.fetch("/automations/trigger", { method: "POST", body: "{}" }))
      .status,
  ).toBe(401);
  expect(await t.run((ctx) => ctx.db.query("runs").take(1))).toHaveLength(0);
});

it("does not let an unread reply from an older turn complete a newer input", async () => {
  const t = backend();
  const id = (await t.mutation(internal.runs.ingest, input))!;
  await t.mutation(internal.runs.attach, {
    runId: id,
    workspaceId: "w1",
    sessionId: "s1",
    deepLink: "conductor://w1",
  });
  const pending = (await t.query(internal.runs.nextInput, { runId: id }))!;
  await t.mutation(internal.runs.sent, {
    inputId: pending._id,
    messageId: "new-message",
  });
  vi.stubEnv("CONDUCTOR_API_KEY", "test-only");
  vi.stubEnv("SLACK_BOT_TOKEN", "test-only");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/status")) return Response.json({ status: "idle" });
      if (url.includes("chat.postMessage"))
        return Response.json({ ok: true, ts: "3" });
      return Response.json({
        data: [
          {
            id: "old-answer",
            type: "assistant",
            content: "Done with the previous task",
          },
          {
            id: "new-input-event",
            type: "userMessage",
            content: { id: "new-message", message: "New task" },
          },
          {
            id: "late-old-answer",
            type: "agent",
            content: {
              userMessageId: "old-message",
              rawPayload: {
                event: {
                  type: "item.completed",
                  item: {
                    type: "agentMessage",
                    phase: "final_answer",
                    text: "An older turn completed late",
                  },
                },
              },
            },
          },
        ],
        hasMore: false,
      });
    }),
  );
  expect((await t.action(internal.actions.poll, { runId: id })).done).toBe(
    false,
  );
});

it("does not retry workspace creation after an uncertain outcome", async () => {
  const t = backend();
  vi.stubEnv("CONDUCTOR_API_KEY", "test-only");
  vi.stubEnv("CONDUCTOR_MODEL", "test-model");
  const fetchMock = vi.fn().mockRejectedValue(new Error("response lost"));
  vi.stubGlobal("fetch", fetchMock);
  const id = (await t.mutation(internal.runs.ingest, input))!;
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect((await t.query(internal.runs.get, { runId: id })).status).toBe(
    "attention",
  );
  await expect(t.mutation(internal.runs.resume, { runId: id })).rejects.toThrow(
    "Reconcile workspace creation",
  );
});

it("authenticates automation requests and deduplicates replayed events", async () => {
  const t = backend();
  vi.stubEnv("AUTOMATION_WEBHOOK_SECRET", "test-secret");
  vi.stubEnv("CONDUCTOR_PROJECT_ID", "p1");
  vi.stubEnv("SLACK_TEAM_ID", "T1");
  const request = {
    method: "POST",
    headers: {
      authorization: "Bearer test-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      source: "sentry",
      eventId: "issue1",
      prompt: "Investigate the trace",
    }),
  };
  const first = await t.fetch("/automations/trigger", request);
  const second = await t.fetch("/automations/trigger", request);
  expect(first.status).toBe(202);
  expect(await first.json()).toEqual(await second.json());
  expect(await t.run((ctx) => ctx.db.query("runs").take(10))).toHaveLength(1);
});

it("completes the durable workflow through mocked Conductor and Slack APIs", async () => {
  const t = backend();
  vi.stubEnv("CONDUCTOR_API_KEY", "test-only");
  vi.stubEnv("CONDUCTOR_MODEL", "test-model");
  vi.stubEnv("SLACK_BOT_TOKEN", "test-only");
  let sentId = "";
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith("/workspaces"))
      return Response.json({
        workspaceId: "w1",
        sessionId: "s1",
        deepLink: "conductor://w1",
      });
    if (url.includes("chat.postMessage"))
      return Response.json({ ok: true, ts: "2" });
    if (url.endsWith("/messages") && options?.method === "POST") {
      sentId = JSON.parse(options.body as string).messageId;
      return Response.json({});
    }
    if (url.endsWith("/status")) return Response.json({ status: "idle" });
    if (url.includes("/messages?"))
      return Response.json({
        data: [
          {
            id: "input-event",
            type: "userMessage",
            content: { id: sentId, message: "Fix the bug" },
          },
          {
            id: "answer1",
            type: "agent",
            content: {
              userMessageId: sentId,
              rawPayload: {
                event: {
                  type: "item.completed",
                  item: {
                    type: "agentMessage",
                    phase: "final_answer",
                    text: "Fix ready: https://github.com/example/repo/pull/1",
                  },
                },
              },
            },
          },
        ],
        hasMore: false,
      });
    throw new Error(`Unexpected URL ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const id = (await t.mutation(internal.runs.ingest, input))!;
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const run = await t.query(internal.runs.get, { runId: id });
  expect(run.status).toBe("idle");
  expect(run.cursor).toBe("answer1");
  expect(
    fetchMock.mock.calls.filter(([url]) => url.endsWith("/workspaces")),
  ).toHaveLength(1);
  expect(
    fetchMock.mock.calls.filter(([url]) => url.includes("chat.postMessage")),
  ).toHaveLength(2);
});
