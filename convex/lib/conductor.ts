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

// Never forward tool output or reasoning. Content is untyped in the upstream spec.
export function assistantText(message: {
  type: string;
  content: unknown;
}): string | null {
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
