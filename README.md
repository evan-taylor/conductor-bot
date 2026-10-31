# Conductor Bot

Mention a Slack bot to start a Conductor Cloud workspace. Keep talking in the
thread to steer the same agent. Trigger the same execution pipeline from Executor,
Sentry, or another authenticated webhook.

Built with TypeScript, Convex, and the Convex Workflow component. No separate bot
server or database is required.

## What works

- A mention starts a workspace named from the request in the configured Conductor project.
- The first bot message includes **Open workspace** and **Archive workspace** buttons.
- Archiving is limited to authorized users, stops monitoring and further thread inputs,
  and updates the original message. The workspace can be restored in Conductor;
  start a new Slack thread for new work.
- Authorized human replies in the thread are queued and sent to the same session.
- Recipe instructions are included on the first input only; follow-ups contain just
  the user's message. Agents are instructed to use `babysit-pr` for every PR they
  create and report merge readiness without merging.
- Assistant replies use native Slack Markdown blocks for headings, emphasis,
  links, lists, tables, and code, with plain-text notification fallbacks. Local
  workspace file links are rendered as readable paths instead of broken links.
- Authenticated automation requests create runs and optionally start Slack threads.
- Slack replies to automation-created threads reach their existing workspace.
- Duplicate source messages/events reuse the same run and input record.
- Durable workflows coordinate workspace creation, message delivery, and polling.

This initial release supports **one Slack installation and one Conductor project
per deployment**. It uses Conductor Cloud, not local desktop automation. The
dashboard, installation OAuth, attachments, schedules, and a visual recipe editor
are future extensions. No live integration is claimed until credentials are
configured and a real Slack conversation is exercised.

## Local development

Requires Node.js 22 or newer.

```sh
npm ci
npm run check
CONVEX_AGENT_MODE=anonymous npx convex dev
```

Anonymous mode starts a local Convex backend. It does not provide a public URL
Slack can reach. For a hosted development deployment, run `npx convex dev
--configure` and select your Convex team/project. Deploy production explicitly
with `npm run deploy` when ready.

Generated Convex types are committed so tests and type checking run without
credentials. `convex dev` refreshes them when backend functions change.

## Connect Conductor and Slack

1. Obtain a Conductor API key and a project ID from
   [Conductor's API](https://www.conductor.build/docs/api). Pick an explicit agent
   and model supported by its [OpenAPI contract](https://api.conductor.build/v0/openapi.json).
2. Create and install a Slack app from `slack-manifest.json`. The initial manifest
   deliberately omits event subscriptions: Slack needs the signing secret on the
   backend before it can verify the request URL. Invite the app to the channels
   it should use. You can remove the private-channel scope/event if not needed.
3. Configure the variables in `.env.example` on the Convex deployment using the
   Convex dashboard or `npx convex env set NAME value`. Secrets belong on the
   deployment, not in the repository. Do not paste them into issue reports.
4. Set `SLACK_ALLOWED_USER_IDS` to the member IDs allowed to start and steer agents.
   `SLACK_BOT_USER_ID` is the bot's user ID, not its app ID. Set the signing secret
   before Slack verifies the event URL.
5. Enable event subscriptions to `https://YOUR_DEPLOYMENT.convex.site/slack/events`.
   Wait for Slack to mark the URL verified, then add the bot events `app_mention`,
   `message.channels`, and `message.groups`, and save.
   Enable Interactivity and set its Request URL to
   `https://YOUR_DEPLOYMENT.convex.site/slack/interactions` for button acknowledgements.
   Mention the app: `@Conductor investigate the failing checkout test and open a PR`.
   Once it responds in the thread, reply there without another mention.

The HTTP endpoint verifies Slack's raw-body signature and five-minute replay
window, then persists the event before acknowledging it. It ignores bot messages,
edits, unauthorized users, and ordinary messages in unbound conversations.

## Executor / Sentry automation

Configure Executor to POST a normalized event to:

```text
POST https://YOUR_DEPLOYMENT.convex.site/automations/trigger
Authorization: Bearer <AUTOMATION_WEBHOOK_SECRET>
Content-Type: application/json
```

```json
{
  "source": "sentry",
  "eventId": "my-org:my-project:issue-123:regression-1",
  "recipe": "investigate-error",
  "prompt": "Investigate this Sentry issue. URL: ...\nRelease: ...\nStack trace: ..."
}
```

The response is `202 { "runId": "..." }`. Repeated `source` + `eventId` values
return the existing run without creating another workspace. Use an issue or
regression identifier rather than each individual occurrence to avoid an alert
burst starting multiple investigations. Changing the prompt with the same event
ID does not update the existing task.

Set `AUTOMATION_SLACK_CHANNEL` to have the run create a conversation there. The
bot must already be in the channel. Without it, results remain in Conductor.
Executor owns the upstream Sentry integration and context gathering; this repo
provides the receiving endpoint, not an already-installed Executor app.

## Architecture and extensions

```text
Slack events / authenticated webhook
        -> transactional ingestion + pending inputs
        -> durable workflow
        -> Conductor adapter
        -> transcript cursor + Slack delivery records
```

- `convex/http.ts`: verified trigger adapters.
- `convex/runs.ts`: internal transactional run state and routing.
- `convex/workflow.ts`: orchestration and bounded monitoring.
- `convex/lib/recipes.ts`: named instructions and task preparation.
- `convex/lib/conductor.ts`: execution adapter and response validation.
- `convex/lib/slack.ts`: output destination.

Add a trigger by validating/authenticating its payload and calling `runs.ingest`.
Add a recipe by extending the typed recipe registry. Add another execution backend
by implementing create/send/messages/status operations and dispatching to it from
the action layer. Conductor owns conversation history; Convex input/output rows
track integration deliveries rather than implementing another LLM agent.

## Reliability and recovery

External APIs are not part of a Convex transaction. This project does **not** claim
exactly-once external effects:

- Conductor message sends use a stable UUID and can be retried safely under its
  documented idempotency contract.
- Workspace creation is explicitly non-idempotent upstream. Creation has no
  automatic retry. An uncertain response puts the run in `attention`.
- Slack sends are not automatically retried after uncertain delivery. Confirmed
  deliveries are recorded; an unknown outcome requires operator reconciliation.
- Polling runs about every 15 seconds, with a bounded 480-cycle monitoring window.
  Initial `idle` is not treated as completion: a reply after the latest input must
  appear in the transcript first, so an older turn cannot finish a newer request.
  An idle turn may be asking a question; the next Slack reply resumes the run.
- Workflow failures and monitoring limits appear in the `runs` table with status
  `attention` and an error. The agent may still be running in Conductor. Monitoring
  stopping does not cancel the agent or archive the workspace.
- Pending inputs on an attention run are retained until recovery. The initial
  version requires the operator to inspect Convex; it does not promise a Slack
  failure notification when Slack itself is the failing integration.

To recover an uncertain creation, find the workspace named from the run's `title`
in Conductor (older runs used `bot-<runId>`). Match its project and creation time
as names can repeat, then attach its returned
IDs and link with the internal `runs:attach` function in the Convex dashboard.
If creation definitely did not occur, create the workspace once through Conductor
and attach it. Never restart creation blindly.

For uncertain Slack delivery, inspect the thread. If a message was posted, record
its timestamp with `runs:recordOutput` using its original delivery key (workspace
notice: `workspace:0`; transcript chunk: `message:<messageId>:<chunkIndex>`).
Then call internal `runs:resume` with the run ID. These functions are available to
deployment operators through the dashboard/CLI, never public client endpoints.

Conductor's transcript `content` is untyped in its beta spec. The adapter supports
Codex `agent` events containing completed `agentMessage` items, plus plain assistant
strings and text blocks. It correlates Codex replies using `userMessageId`, not the
transcript event ID. Streaming deltas, reasoning, and tool output are excluded.
Unknown agent formats are skipped; validate a new agent before using it unattended.
After upgrading the adapter, `runs:rewindTranscript` lets an operator replay a run's
transcript. Existing delivery keys prevent already-recorded Slack posts from being
sent again.

## Verification

`npm run check` runs strict TypeScript checking and Vitest tests for signatures,
event normalization, authorization, deduplication, automation-thread routing,
stable message retries, and a complete workflow against mocked external APIs.
GitHub Actions runs the same checks on pushes and pull requests.

After connecting credentials, perform one real mention → workspace → reply →
follow-up → PR conversation, then replay a webhook event to verify it reuses its
run. Live external integration checks require your configured Slack and Conductor
accounts and are separate from the deterministic test suite.
