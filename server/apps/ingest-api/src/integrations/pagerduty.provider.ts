import { Injectable, Logger } from "@nestjs/common";

export interface PagerDutyEvent {
  summary: string;
  severity?: "critical" | "error" | "warning" | "info";
  source?: string;
  /** Stable key so re-triggering the SAME signal dedups into one incident. */
  dedupKey?: string;
  links?: { href: string; text?: string }[];
  customDetails?: Record<string, unknown>;
}

const ENQUEUE_URL = "https://events.pagerduty.com/v2/enqueue";

/**
 * PagerDuty Events API v2 client — the transport for signal alerts. There is NO
 * OAuth: a workspace pastes a SERVICE's Events API v2 integration (routing) key,
 * which IntegrationsService stores encrypted and passes back here per call.
 * `trigger` opens (or dedups) an incident; `resolve` closes it when the signal
 * clears. Verified against PagerDuty's Events API v2 (routing_key, event_action,
 * payload.summary/source/severity, dedup_key). Global fetch; never throws.
 */
@Injectable()
export class PagerDutyProvider {
  private readonly logger = new Logger(PagerDutyProvider.name);

  /** There is no instance-level app to configure — every workspace uses its own
   *  service key, so PagerDuty is always "configured" on the server. */
  get configured(): boolean {
    return true;
  }

  /** Open/dedup an incident. Returns PagerDuty's dedup_key on success, else null. */
  async trigger(
    routingKey: string,
    ev: PagerDutyEvent,
  ): Promise<string | null> {
    const res = await this.enqueue({
      routing_key: routingKey,
      event_action: "trigger",
      ...(ev.dedupKey ? { dedup_key: ev.dedupKey } : {}),
      payload: {
        summary: ev.summary.slice(0, 1024),
        source: ev.source || "Replayfy",
        severity: ev.severity || "warning",
        ...(ev.customDetails ? { custom_details: ev.customDetails } : {}),
      },
      ...(ev.links?.length ? { links: ev.links } : {}),
    });
    return res?.dedup_key ?? null;
  }

  /** Resolve a previously-triggered incident by its dedup key. */
  async resolve(routingKey: string, dedupKey: string): Promise<boolean> {
    const res = await this.enqueue({
      routing_key: routingKey,
      event_action: "resolve",
      dedup_key: dedupKey,
    });
    return !!res;
  }

  /** Validate a key by triggering + immediately resolving a throwaway info event
   *  — lets the connect form confirm the routing key actually works. */
  async verify(routingKey: string): Promise<boolean> {
    const dk = `replayfy-verify-${Date.now()}`;
    const ok = await this.trigger(routingKey, {
      summary: "Replayfy connection test",
      severity: "info",
      dedupKey: dk,
    });
    if (!ok) return false;
    await this.resolve(routingKey, dk).catch(() => undefined);
    return true;
  }

  private async enqueue(
    body: Record<string, unknown>,
  ): Promise<{ dedup_key?: string } | null> {
    try {
      const r = await fetch(ENQUEUE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        this.logger.warn(`PagerDuty enqueue HTTP ${r.status}`);
        return null;
      }
      return (await r.json()) as { dedup_key?: string };
    } catch (e) {
      this.logger.warn(`PagerDuty enqueue failed: ${(e as Error).message}`);
      return null;
    }
  }
}
