import { z } from "zod";

export const slackEnvelope = z.object({
  type: z.literal("event_callback"),
  team_id: z.string(),
  event_id: z.string(),
  event: z.object({
    type: z.enum(["app_mention", "message"]),
    user: z.string().optional(),
    channel: z.string(),
    ts: z.string(),
    thread_ts: z.string().optional(),
    text: z.string().max(30000).optional(),
    bot_id: z.string().optional(),
    subtype: z.string().optional(),
  }),
});

export function normalizeSlack(payload: unknown, botUserId: string) {
  const parsed = slackEnvelope.safeParse(payload);
  if (!parsed.success) return null;
  const { team_id: teamId, event } = parsed.data;
  if (
    !event.user ||
    event.user === botUserId ||
    event.bot_id ||
    (event.subtype && event.subtype !== "file_share")
  )
    return null;
  const text = (event.text ?? "").split(`<@${botUserId}>`).join("").trim();
  if (!text) return null;
  const threadTs = event.thread_ts ?? event.ts;
  return {
    teamId,
    userId: event.user,
    channel: event.channel,
    threadTs,
    text,
    key: `slack:${teamId}:${event.channel}:${event.ts}`,
    runKey: `slack:${teamId}:${event.channel}:${threadTs}`,
    canCreate: event.type === "app_mention",
  };
}
