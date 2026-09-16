import { Module } from "@nestjs/common";
import { WorkspacesController } from "./workspaces.controller";
import { WorkspacesService } from "./workspaces.service";
import { EmailModule } from "../email/email.module";
import { QueueModule } from "../queue/queue.module";
import { NotificationsModule } from "../notifications/notifications.module";

@Module({
  imports: [EmailModule, QueueModule, NotificationsModule],
  controllers: [WorkspacesController],
  providers: [WorkspacesService],
  exports: [WorkspacesService],
})
export class WorkspacesModule {}
