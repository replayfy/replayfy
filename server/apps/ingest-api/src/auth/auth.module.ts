import { Module } from "@nestjs/common";
import { AuthController, MeController } from "./auth.controller";
import { AuthService } from "./auth.service";

@Module({
  controllers: [AuthController, MeController],
  providers: [AuthService],
  exports: [AuthService]
})
export class AuthModule {}
