import { BullModule } from "@nestjs/bull";
import { Global, Module } from "@nestjs/common";
import { EMAIL_QUEUE } from "./email.types";
import { EmailService } from "./email.service";
import { EmailProcessor } from "./email.processor";

/**
 * Bull connection comes from the BullModule.forRootAsync in AppModule.
 * EmailModule just adds its named queue against that shared root.
 */
@Global()
@Module({
  imports: [BullModule.registerQueue({ name: EMAIL_QUEUE })],
  providers: [EmailService, EmailProcessor],
  exports: [EmailService],
})
export class EmailModule {}
