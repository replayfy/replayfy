import { Injectable, Logger } from "@nestjs/common";
import { createHmac } from "node:crypto";

/**
 * Outgoing-webhook client — POSTs a JSON event to a workspace-supplied URL, with
 * an optional HMAC-SHA256 signature (`X-Replayfy-Signature: sha256=…`) computed
 * from the shared secret so the receiver can verify authenticity. There is NO
 * OAuth: the workspace pastes a URL (+ optional secret), stored encrypted by
 * IntegrationsService. Global fetch; never throws.
 */
@Injectable()
export class WebhookProvider {
  private readonly logger = new Logger(WebhookProvider.name);

  get configured(): boolean {
    return true;
  }

  /** POST an event; returns true on a 2xx from the receiver. */
  async send(
    url: string,
    secret: string | undefined,
    payload: unknown,
  ): Promise<boolean> {
    try {
      const bodyStr = JSON.stringify(payload);
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "User-Agent": "Replayfy-Webhook/1",
      };
      if (secret) {
        headers["X-Replayfy-Signature"] =
          "sha256=" +
          createHmac("sha256", secret).update(bodyStr).digest("hex");
      }
      const r = await fetch(url, {
        method: "POST",
        headers,
        body: bodyStr,
      });
      if (!r.ok) {
        this.logger.warn(`Webhook POST HTTP ${r.status}`);
        return false;
      }
      return true;
    } catch (e) {
      this.logger.warn(`Webhook POST failed: ${(e as Error).message}`);
      return false;
    }
  }

  /** Accept only http(s) URLs for the connect form. */
  validUrl(url: string): boolean {
    try {
      const u = new URL(url);
      return u.protocol === "https:" || u.protocol === "http:";
    } catch {
      return false;
    }
  }
}
