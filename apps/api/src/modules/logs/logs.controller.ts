import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { CurrentUser, type AuthUser } from "../../common/current-user.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { LogsService, logQuerySchema } from "./logs.service.js";

@Controller("logs")
@UseGuards(JwtAuthGuard)
export class LogsController {
  constructor(private readonly logs:LogsService) {}
  @Get() list(@CurrentUser() user:AuthUser,@Query() query:unknown) {return this.logs.list(user.id,logQuerySchema.parse(query));}
  @Get(":id") detail(@CurrentUser() user:AuthUser,@Param("id") id:string) {return this.logs.detail(user.id,z.string().uuid().parse(id));}
}
