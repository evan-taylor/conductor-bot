import { z } from "zod";
import { required } from "./config";
export async function postSlack(
  channel: string,
  text: string,
  threadTs?: string,
  mrkdwn = false,
): Promise<string> {
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${required("SLACK_BOT_TOKEN")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel,
      text,
      thread_ts: threadTs,
      unfurl_links: false,
      unfurl_media: false,
      mrkdwn,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error(`Slack request failed (${response.status})`);
  const result = z
    .object({
      ok: z.boolean(),
      ts: z.string().optional(),
      error: z.string().optional(),
    })
    .parse(await response.json());
  if (!result.ok || !result.ts)
    throw new Error(
      `Slack rejected message: ${result.error ?? "unknown_error"}`,
    );
  return result.ts;
}
export function chunks(text: string): string[] {
  const chars = Array.from(text);
  const result: string[] = [];
  for (let i = 0; i < chars.length; i += 3000)
    result.push(chars.slice(i, i + 3000).join(""));
  return result;
}
