import { Module } from "@nestjs/common";
import { LinearProvider } from "./linear.provider";
import { GithubProvider } from "./github.provider";
import { SlackProvider } from "./slack.provider";
import { PagerDutyProvider } from "./pagerduty.provider";
import { WebhookProvider } from "./webhook.provider";
import { JiraProvider } from "./jira.provider";
import { LarkProvider } from "./lark.provider";
import { SentryProvider } from "./sentry.provider";
import { IntegrationsService } from "./integrations.service";
import { IntegrationsController } from "./integrations.controller";

/**
 * Integration Intelligence layer. Each external integration exposes its actions
 * as ordinary registry capabilities (operation:"external") backed by a provider
 * here — so to the planner, "create a funnel" and "create a Linear issue" are
 * identical: it requests a capability, and the backend routes to the right
 * executor via IntegrationsService.
 *
 * Every integration is connected PER WORKSPACE over OAuth (no shared API keys):
 * IntegrationsService owns the encrypted per-workspace tokens + refresh, the
 * controller owns the connect/callback/disconnect flow, and each provider (e.g.
 * LinearProvider) is a thin API client. Adding Slack/GitHub/Jira = a provider +
 * a capability; the planner never changes.
 */
@Module({
  controllers: [IntegrationsController],
  providers: [
    LinearProvider,
    GithubProvider,
    SlackProvider,
    PagerDutyProvider,
    WebhookProvider,
    JiraProvider,
    LarkProvider,
    SentryProvider,
    IntegrationsService,
  ],
  exports: [IntegrationsService],
})
export class IntegrationsModule {}
