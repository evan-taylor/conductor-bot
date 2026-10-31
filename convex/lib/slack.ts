import { z } from "zod";
import { required } from "./config";

async function slackRequest(
  method: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${required("SLACK_BOT_TOKEN")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
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

export async function postSlack(
  channel: string,
  text: string,
  threadTs?: string,
  options: {
    mrkdwn?: boolean;
    markdown?: boolean;
    workspaceUrl?: string;
    runId?: string;
  } = {},
): Promise<string> {
  return slackRequest("chat.postMessage", {
    channel,
    text,
    thread_ts: threadTs,
    unfurl_links: false,
    unfurl_media: false,
    mrkdwn: options.mrkdwn ?? false,
    ...(options.workspaceUrl
      ? { blocks: workspaceButton(options.workspaceUrl, options.runId) }
      : options.markdown
        ? { blocks: [{ type: "markdown", text }] }
        : {}),
  });
}

// Local workspace links cannot be opened by a Slack reader. Preserve the label
// and file location, while leaving web links and literal code untouched.
export function slackFileReferences(text: string): string {
  const readable = (label: string, target: string) => {
    if (/^(?:https?:|mailto:|slack:|conductor:|\/\/)/i.test(target))
      return undefined;
    const path = target
      .replace(/^file:\/\/\//i, "/")
      .replace(/^\/home\/vercel-sandbox\/[^/]+\//, "");
    const code = "`" + path.replace(/`/g, "") + "`";
    return label.replace(/`/g, "") === path ? code : `${label} (${code})`;
  };
  return text.replace(
    /```[\s\S]*?```|~~~[\s\S]*?~~~|\[([^\]\n]+)\]\((<[^>\n]+>|(?:[^()\n]|\([^()\n]*\))+)\)|`+[^`\n]*`+/g,
    (match, label: string | undefined, destination: string | undefined) => {
      if (label === undefined || destination === undefined) return match;
      const target = destination.startsWith("<")
        ? destination.slice(1, -1)
        : destination.replace(/\s+["'][^"']*["']$/, "");
      return readable(label, target) ?? match;
    },
  );
}

export function chunks(text: string): string[] {
  const chars = Array.from(text);
  const result: string[] = [];
  for (let i = 0; i < chars.length; i += 3000)
    result.push(chars.slice(i, i + 3000).join(""));
  return result;
}

export function workspaceButton(
  url: string,
  runId?: string,
  status = "active",
) {
  const stateText =
    status === "archived"
      ? "Workspace archived."
      : status === "archiving"
        ? "Archiving workspace…"
        : status === "archive_failed"
          ? "Couldn’t archive the workspace. Try again."
          : undefined;
  return [
    ...(stateText
      ? [
          {
            type: "context",
            elements: [{ type: "plain_text", text: stateText }],
          },
        ]
      : []),
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: "open_workspace",
          text: { type: "plain_text", text: "Open workspace" },
          url,
        },
        ...(runId && status !== "archived" && status !== "archiving"
          ? [
              {
                type: "button",
                action_id: "archive_workspace",
                text: { type: "plain_text", text: "Archive workspace" },
                value: runId,
              },
            ]
          : []),
      ],
    },
  ];
}

export async function updateWorkspaceMessage(
  channel: string,
  ts: string,
  url: string,
  runId: string,
  status: string,
) {
  return slackRequest("chat.update", {
    channel,
    ts,
    text:
      status === "archived" ? "Workspace archived." : `Open workspace: ${url}`,
    blocks: workspaceButton(url, runId, status),
    mrkdwn: false,
  });
}
