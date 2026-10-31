import { z } from "zod";
import { required } from "./config";

export const workspaceSchema = z.object({
  workspaceId: z.string(),
  sessionId: z.string(),
  deepLink: z.string(),
});
export const transcriptSchema = z.object({
  data: z.array(
    z.object({ id: z.string(), type: z.string(), content: z.unknown() }),
  ),
  hasMore: z.boolean(),
});
export const statusSchema = z.object({
  status: z.enum(["idle", "working", "error"]),
});

async function request(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`https://api.conductor.build/v0${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${required("CONDUCTOR_API_KEY")}`,
      "Content-Type": "application/json",
      "User-Agent": "conductor-bot/0.1",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(45000),
  });
  if (!response.ok)
    throw new Error(`Conductor request failed (${response.status})`);
  return response.json();
}

// This adapter is the only module coupled to Conductor's beta HTTP contract.
export const conductor = {
  async create(projectId: string, name: string) {
    return workspaceSchema.parse(
      await request("/workspaces", {
        projectId,
        name,
        agent: process.env.CONDUCTOR_AGENT ?? "codex",
        model: required("CONDUCTOR_MODEL"),
      }),
    );
  },
  async send(sessionId: string, message: string, messageId: string) {
    await request(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
      message,
      messageId,
    });
  },
  async messages(sessionId: string, cursor?: string) {
    const query = new URLSearchParams({ limit: "50" });
    if (cursor) query.set("after", cursor);
    return transcriptSchema.parse(
      await request(
        `/sessions/${encodeURIComponent(sessionId)}/messages?${query}`,
      ),
    );
  },
  async status(sessionId: string) {
    return statusSchema.parse(
      await request(`/sessions/${encodeURIComponent(sessionId)}/status`),
    );
  },
};

type TranscriptMessage = { id?: string; type: string; content: unknown };

const codexEvent = z.object({
  userMessageId: z.string(),
  rawPayload: z.object({
    event: z.object({
      type: z.string(),
      item: z
        .object({
          type: z.string(),
          text: z.string().optional(),
          phase: z.string().nullish(),
        })
        .optional(),
    }),
  }),
});

// The transcript event ID differs from the idempotency ID supplied on send.
export function inputMessageId(message: TranscriptMessage): string | undefined {
  if (message.type === "userMessage") {
    const parsed = z.object({ id: z.string() }).safeParse(message.content);
    return parsed.success ? parsed.data.id : undefined;
  }
  if (message.type === "agent") {
    const parsed = codexEvent.safeParse(message.content);
    return parsed.success ? parsed.data.userMessageId : undefined;
  }
  return message.type === "user" ? message.id : undefined;
}

// Forward only completed visible messages, never streaming deltas, tools or reasoning.
export function assistantText(message: TranscriptMessage): string | null {
  if (message.type === "agent") {
    const parsed = codexEvent.safeParse(message.content);
    if (!parsed.success) return null;
    const event = parsed.data.rawPayload.event;
    if (event.type !== "item.completed" || event.item?.type !== "agentMessage")
      return null;
    if (
      event.item.phase &&
      !["final_answer", "commentary"].includes(event.item.phase)
    )
      return null;
    return event.item.text?.trim() || null;
  }
  if (message.type !== "assistant") return null;
  const content = message.content;
  if (typeof content === "string") return content.trim() || null;
  if (!content || typeof content !== "object") return null;
  const obj = content as Record<string, unknown>;
  if (obj.type && !["text", "message", "assistant"].includes(String(obj.type)))
    return null;
  if (obj.role && obj.role !== "assistant") return null;
  if (typeof obj.text === "string") return obj.text.trim() || null;
  const blocks = Array.isArray(content) ? content : obj.content;
  if (typeof blocks === "string") return blocks.trim() || null;
  if (!Array.isArray(blocks)) return null;
  return (
    blocks
      .flatMap((block) =>
        block && block.type === "text" && typeof block.text === "string"
          ? [block.text]
          : [],
      )
      .join("\n")
      .trim() || null
  );
}

export function workspaceName(request: string): string {
  const title = request
    .replace(/<[^>|]+\|([^>]+)>/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:(?:can|could|would) you\s+)?(?:please\s+)?/i, "")
    .replace(/[.?!\s]+$/u, "")
    .trim();
  if (!title) return "Slack task";
  const shortened =
    title.length > 80 ? title.slice(0, 77).replace(/\s+\S*$/, "") + "…" : title;
  return shortened[0].toUpperCase() + shortened.slice(1);
}
