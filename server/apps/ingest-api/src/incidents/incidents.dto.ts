import { IsIn, IsOptional } from "class-validator";

const INCIDENT_STATUSES = ["OPEN", "ACK", "RESOLVED"] as const;

/**
 * Body for PATCH /v1/dashboard/incidents/:id — the Acknowledge / Resolve
 * action on an incident card. `status` is the only field the controller and
 * IncidentsService.setStatus read; it stays optional because the controller
 * defaults to "ACK" when omitted. The global ValidationPipe's `whitelist`
 * strips anything else, so the closed status vocabulary is the whole body.
 */
export class SetIncidentStatusDto {
  @IsOptional()
  @IsIn(INCIDENT_STATUSES)
  status?: (typeof INCIDENT_STATUSES)[number];
}
