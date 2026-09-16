import { IsIn, IsOptional } from "class-validator";

const ISSUE_STATUSES = ["OPEN", "RESOLVED", "IGNORED"] as const;

/**
 * Human status action body for PATCH /v1/dashboard/issues/:id (Resolve /
 * Ignore / Reopen). `status` is the only field the controller/service read —
 * it is passed straight into IssuesService.setStatus, defaulting to
 * "RESOLVED" when omitted. Optional so a bare PATCH still resolves; the
 * @IsIn union keeps the value assignable to the service's status param and the
 * global whitelist strips anything else a client might send.
 */
export class SetIssueStatusDto {
  @IsOptional()
  @IsIn(ISSUE_STATUSES)
  status?: (typeof ISSUE_STATUSES)[number];
}
