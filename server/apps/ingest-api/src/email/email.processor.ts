import { Processor, Process } from "@nestjs/bull";
import { Logger } from "@nestjs/common";
import type { Job } from "bull";
import { Resend } from "resend";
import { createTransport, type Transporter } from "nodemailer";
import { EMAIL_QUEUE, EMAIL_JOB_SEND, type EmailJob } from "./email.types";

type EmailProviderKind = "resend" | "smtp" | "console";

@Processor(EMAIL_QUEUE)
export class EmailProcessor {
  private readonly logger = new Logger(EmailProcessor.name);
  /** From header. `EMAIL_FROM` sets the whole header (display name + address);
   *  it falls back to the domain identity `Replayfy <hello@EMAIL_DOMAIN>`. For
   *  Resend the address's domain must be verified; for SMTP it must be one the
   *  relay accepts. */
  private readonly fromEmail =
    process.env.EMAIL_FROM || `Replayfy <hello@${process.env.EMAIL_DOMAIN}>`;
  /** Selected transport. `EMAIL_PROVIDER` (resend|smtp|console) wins; when unset
   *  it is inferred so existing deployments keep working with zero config:
   *  Resend if RESEND_API_KEY is set (the cloud build), SMTP if SMTP_HOST is set,
   *  otherwise console (log-only) — which is the sane default for a fresh
   *  self-host that hasn't wired an email relay yet. */
  private readonly provider: EmailProviderKind;
  private readonly resend: Resend | null = null;
  private readonly smtp: Transporter | null = null;

  constructor() {
    this.provider = this.resolveProvider();
    if (this.provider === "resend") {
      this.resend = new Resend(process.env.RESEND_API_KEY);
      if (!process.env.EMAIL_FROM && !process.env.EMAIL_DOMAIN) {
        // The From then defaults to a bare address whose domain is `undefined` —
        // every send would be rejected. Make that misconfiguration loud.
        this.logger.warn(
          `EMAIL_FROM/EMAIL_DOMAIN unset — sending as "${this.fromEmail}", whose domain must be verified in Resend or every message is rejected`,
        );
      }
    } else if (this.provider === "smtp") {
      const port = Number(process.env.SMTP_PORT ?? 587);
      this.smtp = createTransport({
        host: process.env.SMTP_HOST,
        port,
        // `SMTP_SECURE=true` for implicit TLS (port 465); otherwise STARTTLS is
        // negotiated on the plaintext port (587/25).
        secure: process.env.SMTP_SECURE === "true" || port === 465,
        auth:
          process.env.SMTP_USER || process.env.SMTP_PASS
            ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
            : undefined,
      });
    } else {
      this.logger.warn(
        "email provider = console — messages are logged, not delivered (set EMAIL_PROVIDER=resend|smtp to deliver).",
      );
    }
  }

  /** Resolve the transport from env, inferring a safe default when unset. Kept a
   *  method (not a free function) per the repo's no-standalone-fn-in-processor rule. */
  private resolveProvider(): EmailProviderKind {
    const explicit = (process.env.EMAIL_PROVIDER || "").trim().toLowerCase();
    if (explicit === "resend" || explicit === "smtp" || explicit === "console") {
      return explicit;
    }
    if (process.env.RESEND_API_KEY) return "resend";
    if (process.env.SMTP_HOST) return "smtp";
    return "console";
  }

  @Process({ name: EMAIL_JOB_SEND, concurrency: 4 })
  async send(job: Job<EmailJob>): Promise<void> {
    const msg = job.data;

    // The queued `to` may be a comma-joined string (multi-recipient alerts);
    // split + trim + drop blanks. A blank/commas-only recipient would make the
    // provider reject and Bull retry to dead-letter, so drop it here.
    const toAddresses = msg.to
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);
    if (toAddresses.length === 0) {
      this.logger.warn(
        `[email] no valid recipient — dropping message (subject="${msg.subject}")`,
      );
      return;
    }

    if (this.provider === "console") return this.sendViaConsole(msg, toAddresses);
    if (this.provider === "smtp") return this.sendViaSmtp(msg, toAddresses);
    return this.sendViaResend(msg, toAddresses);
  }

  private sendViaConsole(msg: EmailJob, to: string[]): void {
    this.logger.log(`[dev-email] to=${to.join(",")} subject=${msg.subject}`);
    if (msg.textBody) this.logger.debug(msg.textBody);
  }

  private async sendViaSmtp(msg: EmailJob, to: string[]): Promise<void> {
    if (!this.smtp) {
      this.logger.error("[email] SMTP selected but SMTP_HOST is unset — dropping");
      return;
    }
    try {
      const info = await this.smtp.sendMail({
        from: this.fromEmail,
        to,
        subject: msg.subject,
        ...(msg.htmlBody ? { html: msg.htmlBody } : {}),
        text: msg.textBody ?? msg.subject,
      });
      this.logger.log(
        `[email] sent via smtp to=${to.join(",")} tag=${msg.tag ?? "-"} messageId=${info.messageId ?? "?"}`,
      );
    } catch (err) {
      // nodemailer throws on connection/auth/5xx — treat as transient and let
      // Bull retry with its exponential backoff (same posture as Resend below).
      const e = err as { message?: string; responseCode?: number };
      this.logger.error(
        `[email] SMTP send failed (to=${to.join(",")} subject="${msg.subject}"): ${e.message ?? String(err)}`,
      );
      throw err;
    }
  }

  private async sendViaResend(msg: EmailJob, to: string[]): Promise<void> {
    if (!this.resend) return this.sendViaConsole(msg, to);

    // Resend tag name/value are limited to ASCII letters, numbers, `_` and `-`;
    // sanitise defensively so a freeform tag can never fail the send.
    const tags = msg.tag
      ? [
          {
            name: "type",
            value: msg.tag.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256),
          },
        ]
      : undefined;

    let data: { id?: string } | null = null;
    let error: { name?: string; message?: string; statusCode?: number } | null =
      null;
    try {
      ({ data, error } = await this.resend.emails.send({
        from: this.fromEmail,
        to,
        subject: msg.subject,
        // Text is always present as the plain-text fallback; HTML is added only
        // when the template produced one (Resend requires at least one).
        ...(msg.htmlBody ? { html: msg.htmlBody } : {}),
        text: msg.textBody ?? msg.subject,
        ...(tags ? { tags } : {}),
      }));
    } catch (err) {
      // A thrown error is a transport failure (network/DNS/timeout) — always
      // transient, so let Bull retry with its exponential backoff.
      const e = err as { name?: string; message?: string };
      this.logger.error(
        `[email] Resend transport error (to=${to.join(",")} subject="${msg.subject}"): ` +
          `${e.name ?? "Error"} — ${e.message ?? String(err)}`,
      );
      throw err;
    }

    if (error) {
      // Resend reports API-level failures on `error` rather than throwing. The
      // most common on a fresh account is an unverified sending domain, or (in
      // test mode) a recipient that isn't allow-listed.
      const status = error.statusCode;
      this.logger.error(
        `[email] Resend send failed (to=${to.join(",")} subject="${msg.subject}"): ` +
          `${error.name ?? "Error"} — ${error.message ?? "unknown"} [http ${status ?? "?"}]`,
      );
      // Retry only TRANSIENT failures (429 / 5xx / unknown). A permanent 4xx
      // (validation, unverified recipient) will never succeed on retry, so
      // swallow it rather than retry-storm to a dead letter.
      const transient = status == null || status === 429 || status >= 500;
      if (transient)
        throw new Error(
          `Resend ${status ?? "?"}: ${error.message ?? error.name ?? "error"}`,
        );
      return;
    }

    this.logger.log(
      `[email] sent via resend to=${to.join(",")} tag=${msg.tag ?? "-"} messageId=${data?.id ?? "?"}`,
    );
  }
}
