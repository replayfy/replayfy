import { IsBoolean, IsOptional, IsString, MaxLength } from "class-validator";

/**
 * Body for POST /v1/agent and POST /v1/agent/stream — same shape. The global
 * ValidationPipe `whitelist` strips anything not declared here, so both fields
 * that the controller reads (`message`, `conversationId`) are declared. Both are
 * optional: the controller defaults `message` to "" and mints a `conversationId`
 * server-side when absent. `message` cap is generous headroom over the service's
 * MAX_QUESTION (4000) truncation so a long-but-valid prompt is never rejected.
 */
export class AgentRunDto {
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  message?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  conversationId?: string;
}

/**
 * Body for POST /v1/agent/confirm — approve or cancel a parked action. The
 * controller reads `pendingActionId` and `confirm === true`, so both are kept.
 */
export class ConfirmActionDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  pendingActionId?: string;

  @IsOptional()
  @IsBoolean()
  confirm?: boolean;
}

/**
 * Body for POST /v1/agent/clarify — answer an AI clarification. All four fields
 * the controller reads are declared. `value` cap is headroom over the knowledge
 * service's MAX_VALUE (500) truncation; `message` matches AgentRunDto's cap.
 */
export class ClarifyDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  rememberAs?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  value?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8000)
  message?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  conversationId?: string;
}

/**
 * Body for PUT /v1/agent/knowledge — correct a learned fact. The controller
 * reads `key` and `value`; `value` cap is headroom over MAX_VALUE (500).
 */
export class SetKnowledgeDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  key?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  value?: string;
}
