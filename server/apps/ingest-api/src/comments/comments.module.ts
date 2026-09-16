import { Module } from "@nestjs/common";
import { CommentsController, SessionCommentsController } from "./comments.controller";
import { CommentsService } from "./comments.service";

@Module({
  controllers: [CommentsController, SessionCommentsController],
  providers: [CommentsService],
  exports: [CommentsService]
})
export class CommentsModule {}
