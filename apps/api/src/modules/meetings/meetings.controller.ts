import { AiQuotaGuard } from "../../common/request-limits.js";
import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { CurrentUser, type AuthUser } from "../../common/current-user.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { MeetingsService } from "./meetings.service.js";
import { MailService } from "../mail/mail.service.js";

@Controller("conversations/:conversationId/meetings") @UseGuards(JwtAuthGuard, AiQuotaGuard)
export class MeetingsController {
  constructor(private readonly meetings: MeetingsService, private readonly mail: MailService) {}
  @Post("emails/:emailId/retry") retryMail(@CurrentUser() user: AuthUser, @Param("conversationId") id: string, @Param("emailId") emailId: string, @Body() body: unknown) {
    const input = z.object({ inboxChecked: z.boolean().default(false) }).parse(body ?? {});
    return this.mail.retry(user.id, id, emailId, input.inboxChecked);
  }
  @Get() list(@CurrentUser() user: AuthUser, @Param("conversationId") id: string) { return this.meetings.list(user.id, id); }
  @Post("reanalyze") reanalyze(@CurrentUser() user: AuthUser, @Param("conversationId") id: string) { return this.meetings.requestAnalysis(user.id, id, true); }
}
