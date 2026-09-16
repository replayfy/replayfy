import {
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  Min,
} from "class-validator";

/**
 * Create a comment on a session. Fields mirror exactly what
 * CommentsService.create reads off the body (`body`, `atMs`, `parentId`);
 * anything else is stripped by the global ValidationPipe whitelist. The
 * author (userId) and workspace come from the auth context, never the body.
 */
export class CreateCommentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  body!: string;

  // Playback offset (ms) the comment is pinned to; non-negative integer.
  @IsInt()
  @Min(0)
  atMs!: number;

  // Optional parent comment id for threaded replies.
  @IsOptional()
  @IsInt()
  @Min(1)
  parentId?: number;
}

/**
 * Edit a comment's text. Only `body` is mutable — CommentsService.update
 * reads nothing else off the body.
 */
export class UpdateCommentDto {
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  body?: string;
}
