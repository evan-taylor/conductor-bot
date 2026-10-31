import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { verifySlackRequest, stableUuid } from "../convex/lib/security";
import { normalizeSlack } from "../convex/lib/slackEvents";
import {
  assistantText,
  conductor,
  inputMessageId,
} from "../convex/lib/conductor";
import { chunks } from "../convex/lib/slack";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("request verification", () => {
  it("accepts the raw signed body and rejects tampering and replay", async () => {
    const body = '{"text":"hello"}';
    const timestamp = "1800000000";
    const signature = `v0=${createHmac("sha256", "secret").update(`v0:${timestamp}:${body}`).digest("hex")}`;
    expect(
      await verifySlackRequest(
        "secret",
        body,
        timestamp,
        signature,
        1800000000000,
      ),
    ).toBe(true);
    expect(
      await verifySlackRequest(
        "secret",
        body + " ",
        timestamp,
        signature,
        1800000000000,
      ),
    ).toBe(false);
    expect(
      await verifySlackRequest(
        "secret",
        body,
        timestamp,
        signature,
        1800000400000,
      ),
    ).toBe(false);
    expect(await verifySlackRequest("secret", body, "NaN", signature)).toBe(
      false,
    );
  });
});
describe("Slack routing", () => {
  const envelope = {
    type: "event_callback",
    team_id: "T1",
    event_id: "E1",
    event: {
      type: "app_mention",
      user: "U1",
      channel: "C1",
      ts: "100.1",
      text: "<@BOT> fix this",
    },
  };
  it("deduplicates app_mention and message deliveries of the same message", () => {
    const mention = normalizeSlack(envelope, "BOT")!;
    const message = normalizeSlack(
      {
        ...envelope,
        event_id: "E2",
        event: { ...envelope.event, type: "message" },
      },
      "BOT",
    )!;
    expect(mention.key).toBe(message.key);
    expect(mention.canCreate).toBe(true);
    expect(message.canCreate).toBe(false);
    expect(mention.text).toBe("fix this");
  });
  it("routes replies to the parent and ignores bot echoes and edits", () => {
    expect(
      normalizeSlack(
        { ...envelope, event: { ...envelope.event, thread_ts: "99.1" } },
        "BOT",
      )?.runKey,
    ).toBe("slack:T1:C1:99.1");
    expect(
      normalizeSlack(
        { ...envelope, event: { ...envelope.event, bot_id: "B1" } },
        "BOT",
      ),
    ).toBeNull();
    expect(
      normalizeSlack(
        {
          ...envelope,
          event: { ...envelope.event, subtype: "message_changed" },
        },
        "BOT",
      ),
    ).toBeNull();
  });
});
describe("Conductor contract", () => {
  it("uses workspaceId and stable messageId from the current API", async () => {
    vi.stubEnv("CONDUCTOR_API_KEY", "test-only");
    vi.stubEnv("CONDUCTOR_MODEL", "configured-model");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          workspaceId: "w1",
          sessionId: "s1",
          deepLink: "conductor://w1",
        }),
      )
      .mockResolvedValueOnce(Response.json({ messageId: "m1" }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await conductor.create("p1", "test")).workspaceId).toBe("w1");
    const id = await stableUuid("input1");
    expect(id).toBe(await stableUuid("input1"));
    expect(id).not.toBe(await stableUuid("input2"));
    await conductor.send("s1", "hello", id);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      message: "hello",
      messageId: id,
    });
  });
  it("extracts assistant text without forwarding tools or reasoning", () => {
    expect(
      assistantText({
        type: "assistant",
        content: { type: "thinking", text: "private reasoning" },
      }),
    ).toBeNull();
    expect(
      assistantText({
        type: "assistant",
        content: {
          content: [
            { type: "thinking", text: "secret" },
            { type: "text", text: "Done" },
          ],
        },
      }),
    ).toBe("Done");
    expect(
      assistantText({ type: "tool_result", content: "sensitive" }),
    ).toBeNull();
    expect(
      assistantText({ type: "assistant", content: { unexpected: "shape" } }),
    ).toBeNull();
  });
  it("chunks without splitting surrogate pairs", () => {
    const text = "😀".repeat(6001);
    expect(chunks(text)).toHaveLength(3);
    expect(chunks(text).join("")).toBe(text);
  });
});

describe("live Codex transcript format", () => {
  const event = (type: string, itemType: string, phase = "final_answer") => ({
    id: "event-id",
    type: "agent",
    content: {
      userMessageId: "client-input-id",
      rawPayload: {
        event: { type, item: { type: itemType, text: "Connected", phase } },
      },
    },
  });
  it("relays completed agent messages and correlates the client input ID", () => {
    const message = event("item.completed", "agentMessage");
    expect(assistantText(message)).toBe("Connected");
    expect(inputMessageId(message)).toBe("client-input-id");
    expect(
      inputMessageId({
        id: "different-event-id",
        type: "userMessage",
        content: { id: "client-input-id" },
      }),
    ).toBe("client-input-id");
  });
  it("does not relay tools, reasoning, or partial text", () => {
    expect(assistantText(event("item.started", "agentMessage"))).toBeNull();
    expect(
      assistantText(event("item.completed", "commandExecution")),
    ).toBeNull();
    expect(assistantText(event("item.completed", "reasoning"))).toBeNull();
    expect(
      assistantText(event("item.completed", "agentMessage", "analysis")),
    ).toBeNull();
  });
});
