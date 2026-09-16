import { Controller, Get, HttpException, HttpStatus } from "@nestjs/common";

@Controller("dev")
export class DevController {
  @Get("ping")
  ping() {
    return {
      ok: true,
      at: new Date().toISOString(),
    };
  }

  @Get("fail")
  fail() {
    throw new HttpException(
      "Intentional failure for SDK testing",
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
}
