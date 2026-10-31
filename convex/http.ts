import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { z } from "zod";
import { required, slackAccess } from "./lib/config";
import { equalSecret, verifySlackRequest } from "./lib/security";
import { normalizeSlack } from "./lib/slackEvents";
import { isRecipe } from "./lib/recipes";

const http = httpRouter();
http.route({
  path: "/health",
  method: "GET",
  handler: httpAction(async () => Response.json({ ok: true })),
});

http.route({
  path: "/slack/events",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.text();
    if (body.length > 100000)
      return new Response("Payload too large", { status: 413 });
    if (
      !(await verifySlackRequest(
        required("SLACK_SIGNING_SECRET"),
        body,
        request.headers.get("x-slack-request-timestamp"),
        request.headers.get("x-slack-signature"),
      ))
    ) {
      return new Response("Unauthorized", { status: 401 });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    const challenge = z
      .object({ type: z.literal("url_verification"), challenge: z.string() })
      .safeParse(payload);
    if (challenge.success)
      return Response.json({ challenge: challenge.data.challenge });
    const event = normalizeSlack(payload, required("SLACK_BOT_USER_ID"));
    if (!event || !slackAccess(event.teamId, event.userId))
      return new Response("ok");
    await ctx.runMutation(internal.runs.ingest, {
      key: event.key,
      runKey: event.runKey,
      text: event.text,
      canCreate: event.canCreate,
      source: "slack",
      projectId: required("CONDUCTOR_PROJECT_ID"),
      recipe: "coding",
      channel: event.channel,
      threadTs: event.threadTs,
      teamId: event.teamId,
    });
    return new Response("ok");
  }),
});

// URL buttons still send a signed interaction; acknowledge without starting work.
http.route({
  path: "/slack/interactions",
  method: "POST",
  handler: httpAction(async (_ctx, request) => {
    const body = await request.text();
    if (body.length > 100000)
      return new Response("Payload too large", { status: 413 });
    if (
      !(await verifySlackRequest(
        required("SLACK_SIGNING_SECRET"),
        body,
        request.headers.get("x-slack-request-timestamp"),
        request.headers.get("x-slack-signature"),
      ))
    ) {
      return new Response("Unauthorized", { status: 401 });
    }
    return new Response(null, { status: 200 });
  }),
});

const webhookPayload = z
  .object({
    eventId: z.string().min(1).max(200),
    source: z.string().regex(/^[a-zA-Z0-9_-]{1,50}$/),
    prompt: z.string().min(1).max(30000),
    recipe: z.string().default("investigate-error"),
  })
  .strict();
http.route({
  path: "/automations/trigger",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (
      !(await equalSecret(
        request.headers.get("authorization") ?? "",
        `Bearer ${required("AUTOMATION_WEBHOOK_SECRET")}`,
      ))
    )
      return new Response("Unauthorized", { status: 401 });
    const body = await request.text();
    if (body.length > 100000)
      return new Response("Payload too large", { status: 413 });
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    const parsed = webhookPayload.safeParse(json);
    if (!parsed.success || !isRecipe(parsed.data.recipe))
      return new Response("Invalid automation payload", { status: 400 });
    const { source, eventId, prompt, recipe } = parsed.data;
    const key = `webhook:${source}:${eventId}`;
    const runId = await ctx.runMutation(internal.runs.ingest, {
      key,
      runKey: key,
      text: prompt,
      canCreate: true,
      source: "webhook",
      projectId: required("CONDUCTOR_PROJECT_ID"),
      recipe,
      channel: process.env.AUTOMATION_SLACK_CHANNEL,
      teamId: required("SLACK_TEAM_ID"),
    });
    return Response.json({ runId }, { status: 202 });
  }),
});
export default http;
