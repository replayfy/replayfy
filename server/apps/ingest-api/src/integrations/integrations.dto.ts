import { IsOptional, IsString, MaxLength, MinLength } from "class-validator";

/**
 * Store a workspace's PagerDuty Events API v2 integration key. The service
 * verifies + encrypts it server-side; the ValidationPipe's `whitelist` strips
 * anything else so only the key reaches the service.
 */
export class ConfigurePagerDutyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  integrationKey!: string;
}

/**
 * Store a workspace's outgoing-webhook URL. The signing secret is minted
 * server-side (never a user input), so the body carries only the URL.
 */
export class ConfigureWebhookDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2048)
  url!: string;
}

/**
 * File a Linear/GitHub/Jira/Lark issue (or post a Slack notification) about ONE
 * recording. `sessionPublicId` resolves the session inside the caller's
 * workspace; `title` optionally overrides the generated issue title. Fields
 * stay assignable to the service's `{ sessionPublicId?; title? }` param.
 */
export class CreateSessionIssueDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  sessionPublicId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;
}
