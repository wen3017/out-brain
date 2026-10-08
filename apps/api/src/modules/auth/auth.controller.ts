import { Body, Controller, Get, Post, Req, Res, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "./jwt-auth.guard.js";
import { CurrentUser, type AuthUser } from "../../common/current-user.js";
import { AuthRateGuard } from "../../common/request-limits.js";
import type { Request, Response } from "express";
import { z } from "zod";
import { AuthService } from "./auth.service.js";

const credentials = z.object({ username: z.string().max(64), password: z.string().max(128) });

@Controller("auth")
@UseGuards(AuthRateGuard)
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Get("options") options() { return { registrationEnabled: process.env.REGISTRATION_ENABLED !== "false" }; }

  @Post("password") @UseGuards(JwtAuthGuard)
  async password(@CurrentUser() user: AuthUser, @Body() body: unknown, @Res({passthrough:true}) res: Response) {
    const input = z.object({currentPassword:z.string().min(1).max(128),newPassword:z.string().min(8).max(128)}).parse(body);
    const result = await this.auth.changePassword(user.id,input.currentPassword,input.newPassword);
    res.clearCookie("nbboss_access"); res.clearCookie("nbboss_refresh");
    return result;
  }

  @Post("register")
  async register(@Body() body: unknown, @Res({ passthrough: true }) res: Response, @Req() req: Request) {
    return this.setCookies(res, await this.auth.register(...this.values(body)), req);
  }

  @Post("login")
  async login(@Body() body: unknown, @Res({ passthrough: true }) res: Response, @Req() req: Request) {
    return this.setCookies(res, await this.auth.login(...this.values(body)), req);
  }

  @Post("refresh")
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.setCookies(res, await this.auth.refresh(req.cookies?.nbboss_refresh));
  }

  @Post("logout")
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.nbboss_refresh);
    res.clearCookie("nbboss_access"); res.clearCookie("nbboss_refresh");
    return { ok: true };
  }

  private values(body: unknown): [string, string] { const v = credentials.parse(body); return [v.username.trim(), v.password]; }
  private setCookies(res: Response, value: { user: unknown; accessToken: string; refreshToken: string }, req?: Request) {
    if(req && value.user && typeof value.user === "object" && "id" in value.user && typeof value.user.id === "string") (req as Request & {user:{id:string}}).user={id:value.user.id};
    const secure = process.env.NODE_ENV === "production" || process.env.COOKIE_SECURE === "true";
    res.cookie("nbboss_access", value.accessToken, { httpOnly: true, sameSite: "lax", secure, maxAge: 15 * 60_000 });
    res.cookie("nbboss_refresh", value.refreshToken, { httpOnly: true, sameSite: "lax", secure, maxAge: 7 * 86400_000 });
    return { user: value.user };
  }
}
