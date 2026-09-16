import { Controller, Get, Headers } from "@nestjs/common";
import { SdkConfigService } from "./sdk-config.service";
import { SkipThrottle } from "@nestjs/throttler";

// Public, high-volume SDK bootstrap fetch (once per end-user session, keyed by
// the end-user's IP — a shared NAT can legitimately exceed the global limit).
// Exempt from throttling, like the ingest routes.
@SkipThrottle()
@Controller("v1/sdk")
export class SdkConfigController {
  constructor(private readonly service: SdkConfigService) {}

  @Get("config")
  config(
    @Headers("x-replay-api-key") apiKey: string,
    // Browsers set Origin on every CORS GET; Referer is the fallback for
    // same-origin or older user-agents. The service decides whether the
    // host matches the workspace's allowlist.
    @Headers("origin") origin: string | undefined,
    @Headers("referer") referer: string | undefined,
  ) {
    return this.service.resolve(apiKey, origin ?? referer);
  }
}
