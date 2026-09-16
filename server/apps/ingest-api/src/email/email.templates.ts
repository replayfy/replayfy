/**
 * Branded HTML templates for transactional emails. Table-based and fully
 * inlined: Outlook/Windows ignores <style> blocks, flexbox, and grid.
 * Palette is the dashboard's tokens, hardcoded (mail clients have no CSS vars).
 */

const ACCENT = "#5b5ceb";
const FG = "#111114";
const FG_MUTE = "#6b7280";
const FG_FAINT = "#9aa1ac";
const LINE = "#ececec";
const LINE_STRONG = "#e3e3e6";
const PAGE_BG = "#fafafa";
const SURFACE = "#ffffff";

// Inter is a dashboard-only font; mail clients can't load it, so the emails
// ride the system stack instead. Single quotes are load-bearing: this string is
// interpolated into double-quoted style="..." attributes, and a nested double
// quote would terminate the attribute and drop every declaration after it.
const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
const MONO = `ui-monospace,SFMono-Regular,Menlo,Consolas,monospace`;

const STYLES = {
  body: `margin:0;padding:0;width:100%;background:${PAGE_BG};font-family:${FONT};color:${FG};-webkit-font-smoothing:antialiased;`,
  // The hairline is what actually draws this edge everywhere — Gmail drops
  // box-shadow, so the shadow is a progressive enhancement for the clients that
  // keep it (Apple Mail, Outlook for Mac) and the card must still read without.
  card: `background:${SURFACE};border:1px solid ${LINE};border-radius:8px;box-shadow:0 1px 2px rgba(17,17,20,0.03),0 6px 16px -8px rgba(17,17,20,0.06);`,
  cardPad: `padding:40px 40px 44px;`,
  wordmark: `font-family:${FONT};font-size:14.5px;font-weight:600;color:${FG};letter-spacing:-0.1px;`,
  h1: `margin:0;font-family:${FONT};font-size:25px;line-height:1.28;font-weight:600;letter-spacing:-0.4px;color:${FG};`,
  p: `margin:16px 0 0;font-family:${FONT};font-size:14px;line-height:1.6;color:${FG_MUTE};`,
  small: `margin:14px 0 0;font-family:${FONT};font-size:13px;line-height:1.5;color:${FG_FAINT};`,
  sectionLink: `font-family:${FONT};font-size:14px;font-weight:550;line-height:1.5;color:${ACCENT};text-decoration:none;`,
  sectionDesc: `margin:4px 0 0;font-family:${FONT};font-size:13px;line-height:1.5;color:${FG_MUTE};`,
  urlText: `font-family:${MONO};font-size:12.5px;line-height:1.5;color:${FG_MUTE};word-break:break-all;`,
  footer: `margin:0;font-family:${FONT};font-size:12px;line-height:1.55;color:${FG_FAINT};`,
} as const;

function escape(value: string): string {
  return value.replace(
    /[<>&"']/g,
    (c) =>
      ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[
        c
      ] as string,
  );
}

/** Bulletproof button: <a> padding does the sizing, the td carries the fill so
 *  Outlook (which drops the <a> background) still paints it. */
function button(href: string, label: string): string {
  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin:28px 0 0;border-collapse:separate;">
        <tr>
          <td align="center" bgcolor="${ACCENT}" style="background:${ACCENT};border-radius:6px;">
            <a href="${escape(href)}" style="display:inline-block;padding:12px 20px;font-family:${FONT};font-size:13.5px;font-weight:600;line-height:1;color:#ffffff;text-decoration:none;border-radius:6px;">${label}</a>
          </td>
        </tr>
      </table>`;
}

function section(href: string, label: string, description: string): string {
  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin:32px 0 0;">
        <tr>
          <td style="padding:0 0 20px;border-top:1px solid ${LINE};font-size:0;line-height:0;">&nbsp;</td>
        </tr>
        <tr>
          <td>
            <a href="${escape(href)}" style="${STYLES.sectionLink}">${label} &rarr;</a>
            <p style="${STYLES.sectionDesc}">${description}</p>
          </td>
        </tr>
      </table>`;
}

function fallbackUrl(url: string): string {
  return `<p style="${STYLES.small}">Or paste this link into your browser:</p>
      <p style="margin:6px 0 0;"><a href="${escape(url)}" style="${STYLES.urlText};text-decoration:none;">${escape(url)}</a></p>`;
}

function shell(title: string, content: string, preheader = ""): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="x-apple-disable-message-reformatting" />
    <meta name="color-scheme" content="light" />
    <meta name="supported-color-schemes" content="light" />
    <title>${escape(title)}</title>
  </head>
  <body style="${STYLES.body}">
    <span style="display:none!important;visibility:hidden;opacity:0;height:0;width:0;overflow:hidden;mso-hide:all">${escape(preheader)}</span>
    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background:${PAGE_BG};">
      <tr>
        <td align="center" style="padding:40px 16px;">
          <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="600" style="width:100%;max-width:600px;${STYLES.card}">
            <tr>
              <td style="${STYLES.cardPad}">
                <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin:0 0 32px;">
                  <tr>
                    <td width="20" align="center" bgcolor="${ACCENT}" style="width:20px;height:20px;background:${ACCENT};border-radius:5px;font-family:${FONT};font-size:12px;font-weight:700;line-height:20px;color:#ffffff;">R</td>
                    <td style="padding-left:9px;${STYLES.wordmark}">Replayfy</td>
                  </tr>
                </table>
                ${content}
              </td>
            </tr>
          </table>
          <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="600" style="width:100%;max-width:600px;">
            <tr>
              <td style="padding:20px 4px 0;">
                <p style="${STYLES.footer}">Replayfy &middot; You're receiving this because activity on your Replayfy account triggered it. If this wasn't you, you can safely ignore this message.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function verifyEmailTemplate(opts: {
  name?: string | null;
  verifyUrl: string;
}): { subject: string; html: string; text: string } {
  const greet = opts.name ? escape(opts.name) : "there";
  const content = `<h1 style="${STYLES.h1}">Verify your email</h1>
                <p style="${STYLES.p}">Hi ${greet}, welcome to Replayfy. Confirm your email address to finish setting up your account.</p>
                ${button(opts.verifyUrl, "Verify email")}
                <p style="${STYLES.small}">This link expires in 24 hours.</p>
                ${fallbackUrl(opts.verifyUrl)}`;
  return {
    subject: "Verify your Replayfy account",
    html: shell(
      "Verify your email",
      content,
      "Confirm your email to finish setting up Replayfy.",
    ),
    text: `Hi ${opts.name ?? "there"},\n\nWelcome to Replayfy. Confirm your email address to finish setting up your account:\n\n${opts.verifyUrl}\n\nThis link expires in 24 hours.\n\nReplayfy`,
  };
}

/**
 * Alert-triggered notification email — used for every alert kind (metric,
 * issue/incident recurrence, funnel conversion). `detail` is the one-sentence
 * summary the evaluator builds; the optional CTA deep-links to what fired (e.g.
 * the funnel). Renders through shell/button — no bespoke inline HTML (which the
 * previous inline `sendAlert` string was).
 */
export function alertTemplate(opts: {
  alertName: string;
  detail: string;
  workspaceName?: string | null;
  ctaUrl?: string;
  ctaLabel?: string;
}): { subject: string; html: string; text: string } {
  const where = opts.workspaceName ? ` in ${escape(opts.workspaceName)}` : "";
  const callout = `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin:24px 0 0;">
                <tr>
                  <td style="padding:16px 18px;background:#f6f6fb;border:1px solid ${LINE_STRONG};border-radius:8px;font-family:${FONT};font-size:14px;line-height:1.55;color:${FG};">${escape(opts.detail)}</td>
                </tr>
              </table>`;
  const cta = opts.ctaUrl ? button(opts.ctaUrl, opts.ctaLabel ?? "Open Replayfy") : "";
  const content = `<h1 style="${STYLES.h1}">${escape(opts.alertName)}</h1>
                <p style="${STYLES.p}">An alert you set${where} just triggered.</p>
                ${callout}
                ${cta}`;
  const plainWhere = opts.workspaceName ? ` in ${opts.workspaceName}` : "";
  return {
    subject: `Replayfy alert: ${opts.alertName}`,
    html: shell(opts.alertName, content, opts.detail),
    text: `Your Replayfy alert "${opts.alertName}"${plainWhere} just triggered.\n\n${opts.detail}\n\n${opts.ctaUrl ?? "Open Replayfy to investigate."}`,
  };
}

export function inviteTemplate(opts: {
  inviterName?: string | null;
  workspaceName: string;
  inviteUrl: string;
}): { subject: string; html: string; text: string } {
  const inviterRaw = opts.inviterName ?? "Your teammate";
  const inviter = escape(inviterRaw);
  const ws = escape(opts.workspaceName);
  const content = `<h1 style="${STYLES.h1}">${inviter} invited you to ${ws}</h1>
                <p style="${STYLES.p}">You've been invited to collaborate on the ${ws} workspace on Replayfy — session replay with console, network, and errors on one timeline.</p>
                ${button(opts.inviteUrl, "Accept invite")}
                <p style="${STYLES.small}">This invite expires in 1 hour. Ask whoever sent it to resend if you don't get to it in time.</p>
                ${fallbackUrl(opts.inviteUrl)}`;
  return {
    subject: `${inviterRaw} invited you to ${opts.workspaceName} on Replayfy`,
    html: shell(
      `${inviterRaw} invited you to ${opts.workspaceName}`,
      content,
      `Join ${opts.workspaceName} on Replayfy.`,
    ),
    text: `${inviterRaw} invited you to collaborate on the ${opts.workspaceName} workspace on Replayfy.\n\nAccept the invite:\n\n${opts.inviteUrl}\n\nThis invite expires in 1 hour.\n\nReplayfy`,
  };
}

export function passwordResetTemplate(opts: {
  name?: string | null;
  resetUrl: string;
  expiresInMinutes: number;
}): { subject: string; html: string; text: string } {
  const name = opts.name ? escape(opts.name) : "there";
  const mins = opts.expiresInMinutes;
  const content = `<h1 style="${STYLES.h1}">Reset your password</h1>
                <p style="${STYLES.p}">Hi ${name}, we got a request to reset the password on your Replayfy account. Set a new one below.</p>
                ${button(opts.resetUrl, "Set a new password")}
                <p style="${STYLES.small}">This link expires in ${mins} minutes. If you didn't request this, you can ignore this email — your password won't change unless you use the link.</p>
                ${fallbackUrl(opts.resetUrl)}`;
  return {
    subject: `Reset your Replayfy password`,
    html: shell("Reset your password", content, "Reset your Replayfy password."),
    text: `Hi ${opts.name ?? "there"},\n\nWe got a request to reset the password on your Replayfy account. Set a new one:\n\n${opts.resetUrl}\n\nThis link expires in ${mins} minutes. If you didn't request this, you can ignore this email — your password won't change unless you use the link.\n\nReplayfy`,
  };
}

export function magicLinkTemplate(opts: {
  name?: string | null;
  magicUrl: string;
  expiresInMinutes: number;
}): { subject: string; html: string; text: string } {
  const name = opts.name ? escape(opts.name) : "there";
  const mins = opts.expiresInMinutes;
  const content = `<h1 style="${STYLES.h1}">Your sign-in link</h1>
                <p style="${STYLES.p}">Hi ${name}, use the button below to sign in to Replayfy — no password needed.</p>
                ${button(opts.magicUrl, "Sign in to Replayfy")}
                <p style="${STYLES.small}">This link expires in ${mins} minutes and can be used once. If you didn't request it, you can ignore this email — it won't sign anyone in on its own.</p>
                ${fallbackUrl(opts.magicUrl)}`;
  return {
    subject: "Your Replayfy sign-in link",
    html: shell(
      "Your sign-in link",
      content,
      "Your one-time sign-in link for Replayfy.",
    ),
    text: `Hi ${opts.name ?? "there"},\n\nUse this one-time link to sign in to Replayfy — no password needed:\n\n${opts.magicUrl}\n\nThis link expires in ${mins} minutes and can be used once. If you didn't request it, you can ignore this email — it won't sign anyone in on its own.\n\nReplayfy`,
  };
}

export function welcomeTemplate(opts: {
  workspaceName: string;
  appUrl: string;
}): { subject: string; html: string; text: string } {
  const ws = escape(opts.workspaceName);
  const content = `<h1 style="${STYLES.h1}">Welcome to ${ws}</h1>
                <p style="${STYLES.p}">Your Replayfy workspace is ready. Install the SDK on your site and the first session will appear in your dashboard within seconds.</p>
                ${button(opts.appUrl, "Open dashboard")}
                ${section(opts.appUrl, "Grab your install snippet", "Settings → Install has your API key and the snippet for your stack.")}`;
  return {
    subject: `Welcome to ${opts.workspaceName} on Replayfy`,
    html: shell(
      `Welcome to ${opts.workspaceName}`,
      content,
      "Your Replayfy workspace is ready.",
    ),
    text: `Welcome to ${opts.workspaceName} on Replayfy.\n\nYour workspace is ready. Install the SDK on your site and the first session will appear in your dashboard within seconds.\n\nOpen the dashboard:\n\n${opts.appUrl}\n\nSettings → Install has your API key and the snippet for your stack.\n\nReplayfy`,
  };
}

/** "You're approaching your session limit." Sent once per billing cycle when a
 *  workspace crosses the warning threshold, so it lands while there is still
 *  time to act rather than after capture has already stopped. */
export function usageWarningTemplate(opts: {
  workspaceName: string;
  planLabel: string;
  used: number;
  limit: number;
  billingUrl: string;
  /** True when this plan HARD-STOPS at its cap instead of auto-upgrading (Free).
   *  Without it the 80% mail promises a plan bump and a prorated charge to the
   *  one tier that will simply stop recording. */
  hardStopsAtCap?: boolean;
  /** True for the second alert: they are AT the ceiling and nothing will lift it
   *  automatically (Free, or already on the top self-serve plan), so capture has
   *  actually stopped. The 80% alert is the reassuring one; this one is not. */
  atLimit?: boolean;
  /** They are past the ceiling of the LARGEST self-serve tier, so there is no
   *  higher plan to auto-upgrade into. Recording deliberately keeps running and
   *  is NOT charged as overage — the next step is a sales conversation, not a
   *  cap. Distinct from `atLimit`, whose copy says capture has stopped: saying
   *  that here would be a lie, and saying nothing at all is how a customer ends
   *  up 3x over their plan with no idea and no invoice. */
  aboveTopTier?: boolean;
}): { subject: string; html: string; text: string } {
  const ws = escape(opts.workspaceName);
  const plan = escape(opts.planLabel);
  const used = opts.used.toLocaleString("en-US");
  const limit = opts.limit.toLocaleString("en-US");
  const pct = Math.min(99, Math.round((opts.used / opts.limit) * 100));

  if (opts.aboveTopTier) {
    const heading = `${ws} has passed the ${limit} sessions in ${plan}`;
    const content = `<h1 style="${STYLES.h1}">${heading}</h1>
                <p style="${STYLES.p}">You've recorded <strong>${used}</strong> sessions this cycle, past the <strong>${limit}</strong> included in ${plan}.</p>
                <p style="${STYLES.p}"><strong>Nothing has stopped and nothing extra has been charged.</strong> ${plan} is our largest self-serve plan, so there's no bigger one to move you to automatically — we'd rather keep your recording running and talk to you than cap you or surprise you with an overage bill.</p>
                <p style="${STYLES.p}">At this volume an Enterprise plan is almost certainly cheaper for you, with retention and support sized to match. Reply to this email and we'll put numbers together.</p>
                ${button(opts.billingUrl, "See your usage")}
                <p style="${STYLES.small}">Your session count resets at the start of the next billing cycle. We'll only send this once per cycle.</p>`;
    return {
      subject: `${opts.workspaceName} is past its ${opts.planLabel} session limit — let's talk Enterprise`,
      html: shell(
        heading,
        content,
        `${used} sessions this cycle. Nothing has stopped — but let's size an Enterprise plan.`,
      ),
      text: `${opts.workspaceName} has passed the ${limit} sessions included in ${opts.planLabel}.\n\nYou've recorded ${used} sessions this cycle.\n\nNothing has stopped and nothing extra has been charged. ${opts.planLabel} is our largest self-serve plan, so there's no bigger one to move you to automatically — we'd rather keep your recording running and talk to you than cap you or surprise you with an overage bill.\n\nAt this volume an Enterprise plan is almost certainly cheaper for you, with retention and support sized to match. Reply to this email and we'll put numbers together.\n\nSee your usage:\n\n${opts.billingUrl}\n\nYour session count resets at the start of the next billing cycle.\n\nReplayfy`,
    };
  }

  if (opts.atLimit) {
    const heading = `${ws} has used all ${limit} sessions in ${plan}`;
    const content = `<h1 style="${STYLES.h1}">${heading}</h1>
                <p style="${STYLES.p}">You've recorded <strong>${used}</strong> of the <strong>${limit}</strong> sessions included in ${plan} this cycle, so new session recording is <strong>paused</strong>.</p>
                <p style="${STYLES.p}">Everything already recorded is safe and still available. Moving to a larger plan resumes capture immediately — you're charged only the prorated difference for the rest of this cycle.</p>
                ${button(opts.billingUrl, "Upgrade to resume recording")}
                <p style="${STYLES.small}">If you'd rather wait, capture resumes on its own when your session count resets at the start of the next billing cycle.</p>`;
    return {
      subject: `Recording paused — ${opts.workspaceName} hit its ${opts.planLabel} session limit`,
      html: shell(
        heading,
        content,
        `${used} of ${limit} sessions used — recording is paused.`,
      ),
      text: `${opts.workspaceName} has used all ${limit} sessions included in ${opts.planLabel} this cycle, so new session recording is paused.\n\nEverything already recorded is safe and still available. Moving to a larger plan resumes capture immediately — you're charged only the prorated difference for the rest of this cycle:\n\n${opts.billingUrl}\n\nIf you'd rather wait, capture resumes on its own when your session count resets at the start of the next billing cycle.\n\nReplayfy`,
    };
  }

  const content = `<h1 style="${STYLES.h1}">${ws} is at ${pct}% of its session limit</h1>
                <p style="${STYLES.p}">You've recorded <strong>${used}</strong> of the <strong>${limit}</strong> sessions included in ${plan} this cycle.</p>
                <p style="${STYLES.p}">${
                  opts.hardStopsAtCap
                    ? "Nothing has stopped yet — but recording <strong>pauses</strong> when you reach the limit, and stays paused until your count resets next cycle. Moving to a paid plan keeps it running."
                    : "Nothing has stopped — when you pass the limit we move you to the next plan automatically and charge only the prorated difference for the rest of the cycle. If you'd rather choose the plan yourself, you can change it now."
                }</p>
                ${button(opts.billingUrl, opts.hardStopsAtCap ? "See paid plans" : "Review your plan")}
                <p style="${STYLES.small}">Your session count resets at the start of the next billing cycle.</p>`;
  return {
    subject: `${opts.workspaceName} is at ${pct}% of its ${opts.planLabel} session limit`,
    html: shell(
      `${opts.workspaceName} is at ${pct}% of its session limit`,
      content,
      `${used} of ${limit} sessions used this cycle.`,
    ),
    text: `${opts.workspaceName} is at ${pct}% of its session limit.\n\nYou've recorded ${used} of the ${limit} sessions included in ${opts.planLabel} this cycle.\n\n${opts.hardStopsAtCap ? "Nothing has stopped yet — but recording pauses when you reach the limit, and stays paused until your count resets next cycle. Moving to a paid plan keeps it running:" : "Nothing has stopped — when you pass the limit we move you to the next plan automatically and charge only the prorated difference for the rest of the cycle. If you'd rather choose the plan yourself:"}\n\n${opts.billingUrl}\n\nYour session count resets at the start of the next billing cycle.\n\nReplayfy`,
  };
}

/**
 * Dunning. A subscription invoice didn't collect, so the workspace is now
 * past_due — which shouldNotRecord enforces at FREE's ceiling, not the paid
 * plan's. That is a real, immediate service reduction, so it cannot happen
 * silently; this is the only mail that tells them.
 *
 * `hostedInvoiceUrl` is Stripe's own hosted page and is the fastest fix (pay
 * the invoice with a new card in two clicks, no login), so it's the primary
 * button when Stripe gave us one; the billing page is the fallback.
 */
export function paymentFailedTemplate(opts: {
  workspaceName: string;
  planLabel: string;
  /** What Stripe tried to collect, in cents. */
  amountDueCents: number;
  currency: string;
  /** Stripe's retry number, so the copy escalates rather than repeating. */
  attemptCount: number;
  hostedInvoiceUrl?: string | null;
  billingUrl: string;
}): { subject: string; html: string; text: string } {
  const ws = escape(opts.workspaceName);
  const plan = escape(opts.planLabel);
  const amount = `${(opts.amountDueCents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: (opts.currency || "usd").toUpperCase(),
  })}`;
  const payUrl = opts.hostedInvoiceUrl || opts.billingUrl;
  // Stripe's dunning schedule ends in cancellation. The first notice can be
  // matter-of-fact; a later retry has to say what actually happens if it never
  // clears, or the cancellation arrives as a surprise.
  const later = opts.attemptCount > 1;
  const heading = `We couldn't charge your card for ${ws}`;
  const content = `<h1 style="${STYLES.h1}">${heading}</h1>
                <p style="${STYLES.p}">The <strong>${amount}</strong> payment for ${plan} didn't go through${later ? `, and this was attempt ${opts.attemptCount}` : ""}.</p>
                <p style="${STYLES.p}">Until it clears, ${ws} records at the <strong>free</strong> session allowance rather than its ${plan} one. Everything already recorded is safe and nothing has been deleted.</p>
                ${button(payUrl, "Update payment method")}
                <p style="${STYLES.small}">${later ? "We'll keep retrying for a few more days. If the payment never clears, the subscription is cancelled and the workspace stays on the free plan." : "We'll retry automatically over the next few days — updating your card now settles it immediately."}</p>`;
  return {
    subject: `Action needed: payment failed for ${opts.workspaceName}`,
    html: shell(
      heading,
      content,
      `${amount} didn't go through — ${opts.workspaceName} is limited until it clears.`,
    ),
    text: `We couldn't charge your card for ${opts.workspaceName}.\n\nThe ${amount} payment for ${opts.planLabel} didn't go through${later ? `, and this was attempt ${opts.attemptCount}` : ""}.\n\nUntil it clears, ${opts.workspaceName} records at the free session allowance rather than its ${opts.planLabel} one. Everything already recorded is safe and nothing has been deleted.\n\nUpdate your payment method:\n\n${payUrl}\n\n${later ? "We'll keep retrying for a few more days. If the payment never clears, the subscription is cancelled and the workspace stays on the free plan." : "We'll retry automatically over the next few days — updating your card now settles it immediately."}\n\nReplayfy`,
  };
}

/** The upgrade charge is waiting on the cardholder to authenticate (SCA). NOT a
 *  failure email: their card is fine, and telling them to update it would send
 *  them to fix something that isn't broken. One action, one link. */
export function paymentAuthenticationTemplate(opts: {
  workspaceName: string;
  planLabel: string;
  targetLabel: string;
  limit: number;
  /** Stripe's hosted page when one is usable; null on the auto-upgrade path,
   *  where the rolled-back invoice was voided and the billing page is the
   *  only route that can actually complete the change. */
  authenticateUrl: string | null;
  billingUrl: string;
}): { subject: string; html: string; text: string } {
  const ws = escape(opts.workspaceName);
  const plan = escape(opts.planLabel);
  const target = escape(opts.targetLabel);
  const limit = opts.limit.toLocaleString("en-US");
  const url = opts.authenticateUrl ?? opts.billingUrl;
  const content = `<h1 style="${STYLES.h1}">One quick step to finish your upgrade</h1>
                <p style="${STYLES.p}">${ws} passed the <strong>${limit}</strong> sessions included in ${plan}, so we tried to move it to ${target} — but your bank wants to confirm it's really you before taking the payment.</p>
                <p style="${STYLES.p}">Nothing is wrong with your card. Confirm the upgrade and your bank will ask you to approve it; recording resumes the moment it goes through.</p>
                ${button(url, "Confirm the upgrade")}
                <p style="${STYLES.small}">Until then new sessions are paused at the ${plan} limit. Nothing already recorded is affected, and your ${plan} plan is unchanged.</p>`;
  return {
    subject: `Confirm your payment to finish upgrading ${opts.workspaceName}`,
    html: shell(
      "One quick step to finish your upgrade",
      content,
      "Your bank needs you to confirm this payment — it takes a few seconds.",
    ),
    text: `One quick step to finish your upgrade.\n\n${opts.workspaceName} passed the ${limit} sessions included in ${opts.planLabel}, so we tried to move it to ${opts.targetLabel} — but your bank wants to confirm it's really you before taking the payment.\n\nNothing is wrong with your card. Confirm the upgrade and your bank will ask you to approve it; recording resumes the moment it goes through:\n\n${url}\n\nUntil then new sessions are paused at the ${opts.planLabel} limit. Nothing already recorded is affected.\n\nReplayfy`,
  };
}

/** The upgrade charge failed. Deliberately NOT worded as a downgrade: the
 *  current plan is already paid for and stays, so capture is capped at that
 *  plan's ceiling rather than dropped to Free. */
export function upgradeFailedTemplate(opts: {
  workspaceName: string;
  planLabel: string;
  targetLabel: string;
  limit: number;
  billingUrl: string;
}): { subject: string; html: string; text: string } {
  const ws = escape(opts.workspaceName);
  const plan = escape(opts.planLabel);
  const target = escape(opts.targetLabel);
  const limit = opts.limit.toLocaleString("en-US");
  const content = `<h1 style="${STYLES.h1}">We couldn't process your upgrade</h1>
                <p style="${STYLES.p}">${ws} passed the <strong>${limit}</strong> sessions included in ${plan}, so we tried to move it to ${target} — but the payment didn't go through.</p>
                <p style="${STYLES.p}">Your ${plan} plan is unchanged and still active. New sessions are paused at the ${plan} limit until the payment succeeds, or until your count resets next cycle. Nothing already recorded is affected.</p>
                ${button(opts.billingUrl, "Update payment method")}
                <p style="${STYLES.small}">Add or update a card and we'll complete the upgrade automatically — capture resumes as soon as it goes through.</p>`;
  return {
    subject: `Action needed: upgrade payment failed for ${opts.workspaceName}`,
    html: shell(
      "We couldn't process your upgrade",
      content,
      `Recording is paused at your ${opts.planLabel} limit until payment succeeds.`,
    ),
    text: `We couldn't process your upgrade.\n\n${opts.workspaceName} passed the ${limit} sessions included in ${opts.planLabel}, so we tried to move it to ${opts.targetLabel} — but the payment didn't go through.\n\nYour ${opts.planLabel} plan is unchanged and still active. New sessions are paused at the ${opts.planLabel} limit until the payment succeeds, or until your count resets next cycle. Nothing already recorded is affected.\n\nUpdate your payment method:\n\n${opts.billingUrl}\n\nAdd or update a card and we'll complete the upgrade automatically — capture resumes as soon as it goes through.\n\nReplayfy`,
  };
}
