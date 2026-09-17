import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { JwtAuthGuard } from "../common/auth.guard";
import { RequiresRole, WorkspaceRoleGuard } from "../common/role.guard";
import {
  CurrentWorkspaceId,
  CurrentUserId,
  CurrentRole,
} from "../common/auth.context";
import { AgentService } from "./agent.service";
import { WorkspaceKnowledgeService } from "./workspace-knowledge.service";
import { ResultSetService } from "./result-set.service";
import {
  AgentRunDto,
  ClarifyDto,
  ConfirmActionDto,
  SetKnowledgeDto,
} from "./agent.dto";
import type { AgentStreamEvent } from "./agent-contract";

/**
 * The single Replayfy AI endpoint. Auth + workspace + user + role are resolved
 * server-side from the JWT and passed into the pipeline — the client (and the
 * LLM) never supply a workspaceId. Replaces /v1/ask.
 */
@Controller("v1/agent")
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class AgentController {
  constructor(
    private readonly agent: AgentService,
    private readonly knowledge: WorkspaceKnowledgeService,
    private readonly resultSets: ResultSetService,
  ) {}

  /**
   * Page the recordings behind an AI answer — "Show recordings (N)". Re-executes
   * the saved resultRef (a stored query filter or session-id snapshot) 50/page
   * with a keyset cursor, WITHOUT re-running the AI. Workspace-scoped by the JWT.
   */
  @Get("recordings")
  recordings(
    @CurrentWorkspaceId() workspaceId: number,
    @Query("resultRef") resultRef: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    return this.resultSets.recordings(
      workspaceId,
      resultRef ?? "",
      cursor,
      limit ? Number(limit) : undefined,
    );
  }

  @Post()
  @RequiresRole("MEMBER")
  run(
    @CurrentWorkspaceId() workspaceId: number,
    @CurrentUserId() userId: number,
    @CurrentRole() role: string,
    @Body() body: AgentRunDto,
  ) {
    return this.agent.run(
      workspaceId,
      userId,
      role,
      body?.message ?? "",
      body?.conversationId,
    );
  }

  /**
   * Streaming variant of run() — same inputs, but emits AgentStreamEvents as
   * Server-Sent-Event frames (plan → steps → investigating → narration →
   * [needs_confirmation] → done). POST (not @Sse/GET) so the JWT + body come in
   * normally; the client consumes it with fetch + a ReadableStream reader, not
   * EventSource. Client disconnect (Stop) closes the request → the loop aborts.
   */
  @Post("stream")
  @RequiresRole("MEMBER")
  async stream(
    @CurrentWorkspaceId() workspaceId: number,
    @CurrentUserId() userId: number,
    @CurrentRole() role: string,
    @Body() body: AgentRunDto,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // don't let a proxy buffer SSE
    res.flushHeaders?.();

    let aborted = false;
    // Real AbortController so a client disconnect doesn't just flip a flag the
    // loop checks between steps — it cancels the in-flight model HTTP request,
    // stopping generation (and the token billing) for an answer nobody sees.
    const ac = new AbortController();
    req.on("close", () => {
      aborted = true;
      ac.abort();
    });
    const emit = (event: AgentStreamEvent) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      const message = await this.agent.run(
        workspaceId,
        userId,
        role,
        body?.message ?? "",
        body?.conversationId,
        { emit, isAborted: () => aborted, signal: ac.signal },
      );
      emit({ type: "done", message });
    } catch (error) {
      // A client-disconnect abort surfaces here as an AbortError — that's the
      // expected outcome, not a failure, so don't log it or try to emit (the
      // socket is already gone).
      if (!aborted) {
        console.error(error);
        emit({ type: "error", message: "Something went wrong answering that." });
      }
    } finally {
      if (!res.writableEnded) res.end();
    }
  }

  /**
   * Confirm (or cancel) a parked action the AI proposed — the second half of the
   * execution-preview flow for update/delete/external capabilities. The action
   * runs ONLY here, after the user approves; workspace + user are from the JWT,
   * so a user can only confirm their own pending action.
   */
  @Post("confirm")
  @RequiresRole("MEMBER")
  confirm(
    @CurrentWorkspaceId() workspaceId: number,
    @CurrentUserId() userId: number,
    @CurrentRole() role: string,
    @Body() body: ConfirmActionDto,
  ) {
    return this.agent.confirmAction(
      workspaceId,
      userId,
      role,
      body?.pendingActionId ?? "",
      body?.confirm === true,
    );
  }

  /**
   * Answer a clarification the AI asked (the second half of ask-with-candidates).
   * Persists the picked/typed value to WorkspaceKnowledge under `rememberAs` (so
   * it's never asked again) and re-runs the original `message` — which now
   * succeeds. Workspace + user are from the JWT.
   */
  @Post("clarify")
  @RequiresRole("MEMBER")
  clarify(
    @CurrentWorkspaceId() workspaceId: number,
    @CurrentUserId() userId: number,
    @CurrentRole() role: string,
    @Body() body: ClarifyDto,
  ) {
    return this.agent.clarifyAnswer(
      workspaceId,
      userId,
      role,
      body?.rememberAs ?? "",
      body?.value ?? "",
      body?.message ?? "",
      body?.conversationId,
    );
  }

  /**
   * Owner audit trail — every capability the AI executed in THIS workspace
   * (from the durable AgentExecution log): what ran, whether it was permitted,
   * whether it wrote, and whether it succeeded. Workspace-scoped by the JWT.
   */
  @Get("audit")
  @RequiresRole("MEMBER")
  audit(
    @CurrentWorkspaceId() workspaceId: number,
    @Query("limit") limit?: string,
    @Query("days") days?: string,
  ) {
    return this.agent.auditTrail(workspaceId, {
      limit: limit ? Number(limit) : undefined,
      days: days ? Number(days) : undefined,
    });
  }

  /**
   * "What Replayfy knows about this workspace" — the AI's learned facts. The
   * user can view them all, correct one (PUT — stored as USER_PROVIDED truth),
   * or forget one (DELETE). Workspace-scoped by the JWT.
   */
  @Get("knowledge")
  @RequiresRole("ADMIN")
  listKnowledge(@CurrentWorkspaceId() workspaceId: number) {
    return this.knowledge.list(workspaceId);
  }

  @Put("knowledge")
  @RequiresRole("ADMIN")
  setKnowledge(
    @CurrentWorkspaceId() workspaceId: number,
    @CurrentUserId() userId: number,
    @Body() body: SetKnowledgeDto,
  ) {
    return this.knowledge.set(workspaceId, body?.key ?? "", body?.value ?? "", {
      source: "USER_PROVIDED",
      learnedById: userId,
    });
  }

  @Delete("knowledge/:key")
  @RequiresRole("ADMIN")
  forgetKnowledge(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("key") key: string,
  ) {
    return this.knowledge.remove(workspaceId, key);
  }

  /**
   * End the current session window ("New conversation"/clear) — drops the stored
   * turns so the next message starts cold. Workspace-scoped by the JWT.
   */
  @Delete("conversations/:id")
  @RequiresRole("MEMBER")
  endConversation(
    @CurrentWorkspaceId() workspaceId: number,
    @Param("id") id: string,
  ) {
    return this.agent.endConversation(workspaceId, id);
  }
}
