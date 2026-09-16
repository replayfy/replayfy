import { Global, Module } from "@nestjs/common";
import { LlmService } from "./llm.service";

/**
 * LLM provider layer (doc 10 §3) — resolution, metering, BYOK key crypto,
 * config CRUD. @Global so the cause processor (Slice 7), the Ask service
 * (Slice 8), and the settings controller can inject LlmService without
 * re-importing.
 */
@Global()
@Module({
  providers: [LlmService],
  exports: [LlmService],
})
export class LlmModule {}
