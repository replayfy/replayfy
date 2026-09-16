import { InjectQueue } from "@nestjs/bull";
import { Injectable } from "@nestjs/common";
import type { Queue } from "bull";
import { EMAIL_QUEUE, EMAIL_JOB_SEND, type EmailJob } from "./email.types";
import {
  alertTemplate,
  inviteTemplate,
  magicLinkTemplate,
  passwordResetTemplate,
  paymentAuthenticationTemplate,
  paymentFailedTemplate,
  upgradeFailedTemplate,
  usageWarningTemplate,
  verifyEmailTemplate,
  welcomeTemplate,
} from "./email.templates";

@Injectable()
export class EmailService {
  constructor(
    @InjectQueue(EMAIL_QUEUE) private readonly queue: Queue<EmailJob>,
  ) {}

  private async enqueue(job: EmailJob): Promise<void> {
    await this.queue.add(EMAIL_JOB_SEND, job, {
      attempts: 5,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 7 * 86_400 },
    });
  }

  async sendInvite(opts: {
    to: string;
    workspaceName: string;
    inviteUrl: string;
    inviterName?: string;
  }): Promise<void> {
    const tpl = inviteTemplate({
      inviterName: opts.inviterName,
      workspaceName: opts.workspaceName,
      inviteUrl: opts.inviteUrl,
    });
    await this.enqueue({
      to: opts.to,
      subject: tpl.subject,
      htmlBody: tpl.html,
      textBody: tpl.text,
      tag: "invite",
    });
  }

  async sendVerify(opts: {
    to: string;
    name?: string | null;
    verifyUrl: string;
  }): Promise<void> {
    const tpl = verifyEmailTemplate({
      name: opts.name,
      verifyUrl: opts.verifyUrl,
    });
    await this.enqueue({
      to: opts.to,
      subject: tpl.subject,
      htmlBody: tpl.html,
      textBody: tpl.text,
      tag: "verify",
    });
  }

  async sendWelcome(opts: {
    to: string;
    workspaceName: string;
  }): Promise<void> {
    const tpl = welcomeTemplate({
      workspaceName: opts.workspaceName,
      appUrl: process.env.APP_BASE_URL ?? "http://127.0.0.1:5180",
    });
    await this.enqueue({
      to: opts.to,
      subject: tpl.subject,
      htmlBody: tpl.html,
      textBody: tpl.text,
      tag: "welcome",
    });
  }

  async sendPasswordReset(opts: {
    to: string;
    name?: string | null;
    resetUrl: string;
    expiresInMinutes: number;
  }): Promise<void> {
    const tpl = passwordResetTemplate({
      name: opts.name,
      resetUrl: opts.resetUrl,
      expiresInMinutes: opts.expiresInMinutes,
    });
    await this.enqueue({
      to: opts.to,
      subject: tpl.subject,
      htmlBody: tpl.html,
      textBody: tpl.text,
      tag: "password-reset",
    });
  }

  /** Passwordless "email me a sign-in link" email — same branded shell/button as
   *  every other transactional email (email.templates), not a bespoke inline one. */
  async sendMagicLink(opts: {
    to: string;
    name?: string | null;
    magicUrl: string;
    expiresInMinutes: number;
  }): Promise<void> {
    const tpl = magicLinkTemplate({
      name: opts.name,
      magicUrl: opts.magicUrl,
      expiresInMinutes: opts.expiresInMinutes,
    });
    await this.enqueue({
      to: opts.to,
      subject: tpl.subject,
      htmlBody: tpl.html,
      textBody: tpl.text,
      tag: "magic-link",
    });
  }

  /** A triggered-alert notification email (queued like the rest). */
  async sendAlert(opts: {
    to: string;
    alertName: string;
    detail: string;
    workspaceName?: string;
    /** Optional deep-link to what fired (e.g. the funnel) — renders a CTA button. */
    ctaUrl?: string;
    ctaLabel?: string;
  }): Promise<void> {
    // Through the shared template (shell/button) like every other transactional
    // email — never bespoke inline HTML.
    const { subject, html, text } = alertTemplate({
      alertName: opts.alertName,
      detail: opts.detail,
      workspaceName: opts.workspaceName,
      ctaUrl: opts.ctaUrl,
      ctaLabel: opts.ctaLabel,
    });
    await this.enqueue({
      to: opts.to,
      subject,
      htmlBody: html,
      textBody: text,
      tag: "alert",
    });
  }

  /** "You're approaching your session limit" — sent once per billing cycle,
   *  while there's still time to act rather than after capture has stopped. */
  async sendUsageWarning(opts: {
    to: string;
    workspaceName: string;
    planLabel: string;
    used: number;
    limit: number;
    /** This plan hard-stops at its cap (Free) rather than auto-upgrading. */
    hardStopsAtCap?: boolean;
    /** Second alert: at the ceiling with no automatic upgrade coming. */
    atLimit?: boolean;
    /** Past the largest self-serve tier: uncapped, unbilled, sales-led. */
    aboveTopTier?: boolean;
  }): Promise<void> {
    const tpl = usageWarningTemplate({
      workspaceName: opts.workspaceName,
      planLabel: opts.planLabel,
      used: opts.used,
      limit: opts.limit,
      hardStopsAtCap: opts.hardStopsAtCap,
      atLimit: opts.atLimit,
      aboveTopTier: opts.aboveTopTier,
      billingUrl: `${process.env.APP_BASE_URL ?? "http://127.0.0.1:5180"}/settings/billing`,
    });
    await this.enqueue({
      to: opts.to,
      subject: tpl.subject,
      htmlBody: tpl.html,
      textBody: tpl.text,
      // Distinct tags so the alerts are separable in the SES event stream — the
      // 100% one is the deliverability-critical one, and the top-tier one is
      // effectively a sales signal the owner will want to filter on.
      tag: opts.aboveTopTier
        ? "usage-above-top-tier"
        : opts.atLimit
          ? "usage-limit"
          : "usage-warning",
    });
  }

  /** A subscription invoice failed to collect. Sent once per FAILURE (the
   *  webhook's event-id dedupe makes a redelivery a no-op), never once per
   *  Stripe retry delivery. */
  async sendPaymentFailed(opts: {
    to: string;
    workspaceName: string;
    planLabel: string;
    amountDueCents: number;
    currency: string;
    attemptCount: number;
    hostedInvoiceUrl?: string | null;
  }): Promise<void> {
    const tpl = paymentFailedTemplate({
      workspaceName: opts.workspaceName,
      planLabel: opts.planLabel,
      amountDueCents: opts.amountDueCents,
      currency: opts.currency,
      attemptCount: opts.attemptCount,
      hostedInvoiceUrl: opts.hostedInvoiceUrl,
      billingUrl: `${process.env.APP_BASE_URL ?? "http://127.0.0.1:5180"}/settings/billing`,
    });
    await this.enqueue({
      to: opts.to,
      subject: tpl.subject,
      htmlBody: tpl.html,
      textBody: tpl.text,
      tag: "payment-failed",
    });
  }

  /** The upgrade needs the cardholder to authenticate (SCA / 3-D Secure). Sent
   *  once, when the queue stops retrying — retrying cannot clear a challenge. */
  async sendPaymentAuthenticationRequired(opts: {
    to: string;
    workspaceName: string;
    planLabel: string;
    targetLabel: string;
    limit: number;
    authenticateUrl: string | null;
  }): Promise<void> {
    const tpl = paymentAuthenticationTemplate({
      workspaceName: opts.workspaceName,
      planLabel: opts.planLabel,
      targetLabel: opts.targetLabel,
      limit: opts.limit,
      authenticateUrl: opts.authenticateUrl,
      billingUrl: `${process.env.APP_BASE_URL ?? "http://127.0.0.1:5180"}/settings/billing`,
    });
    await this.enqueue({
      to: opts.to,
      subject: tpl.subject,
      htmlBody: tpl.html,
      textBody: tpl.text,
      tag: "payment-authentication",
    });
  }

  /** The auto-upgrade charge failed. Worded as "capped at the plan you already
   *  paid for", NOT as a downgrade — the current plan is untouched. */
  async sendUpgradeFailed(opts: {
    to: string;
    workspaceName: string;
    planLabel: string;
    targetLabel: string;
    limit: number;
  }): Promise<void> {
    const tpl = upgradeFailedTemplate({
      workspaceName: opts.workspaceName,
      planLabel: opts.planLabel,
      targetLabel: opts.targetLabel,
      limit: opts.limit,
      billingUrl: `${process.env.APP_BASE_URL ?? "http://127.0.0.1:5180"}/settings/billing`,
    });
    await this.enqueue({
      to: opts.to,
      subject: tpl.subject,
      htmlBody: tpl.html,
      textBody: tpl.text,
      tag: "upgrade-failed",
    });
  }

  private esc(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
}
