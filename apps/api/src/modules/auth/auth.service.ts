import { writeLog } from "../../common/activity-log.js";
import { BadRequestException, ConflictException, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as argon2 from "argon2";
import { createHash, randomUUID } from "node:crypto";
import { PrismaService } from "../../infra/prisma.service.js";

@Injectable()
export class AuthService {
  private readonly accessJwt = new JwtService({ secret: process.env.JWT_ACCESS_SECRET });
  private readonly refreshJwt = new JwtService({ secret: process.env.JWT_REFRESH_SECRET });
  constructor(private readonly prisma: PrismaService) {}

  async register(username: string, password: string) {
    if (process.env.REGISTRATION_ENABLED === "false") throw new ForbiddenException("注册已关闭，请联系维护人员");
    if (!/^[\w\u4e00-\u9fa5.-]{3,32}$/.test(username) || password.length < 8 || password.length > 128) {
      throw new UnauthorizedException("用户名需为 3-32 个字符，密码至少 8 位");
    }
    const exists = await this.prisma.user.findUnique({ where: { username } });
    if (exists) throw new ConflictException("用户名已存在");
    const user = await this.prisma.user.create({ data: { username, passwordHash: await argon2.hash(password, { type: argon2.argon2id }) } });
    return this.issue(user.id, user.username, user.authVersion);
  }

  async login(username: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { username } });
    if (!user || !(await argon2.verify(user.passwordHash, password))) throw new UnauthorizedException("用户名或密码错误");
    return this.issue(user.id, user.username, user.authVersion);
  }

  async refresh(raw: string) {
    try {
      const payload = this.refreshJwt.verify<{ sub: string; username: string; jti: string; version?: number }>(raw);
      const token = await this.prisma.refreshToken.findUnique({ where: { id: payload.jti } });
      if (!token || token.revokedAt || token.expiresAt < new Date() || token.tokenHash !== this.hash(raw)) throw new Error();
      const revoked = await this.prisma.refreshToken.updateMany({ where: { id: token.id, revokedAt: null, expiresAt: { gt: new Date() }, tokenHash: this.hash(raw) }, data: { revokedAt: new Date() } });
      if (revoked.count !== 1) throw new Error();
      return this.issue(payload.sub, payload.username, payload.version ?? 0);
    } catch { throw new UnauthorizedException("刷新令牌无效"); }
  }

  async logout(raw?: string) {
    if (!raw) return;
    try {
      const { jti, sub } = this.refreshJwt.verify<{ jti: string; sub:string }>(raw);
      await this.prisma.refreshToken.updateMany({ where: { id: jti }, data: { revokedAt: new Date() } });
      writeLog({userId:sub,category:"OPERATION",operation:"auth.logout",status:"COMPLETED"});
    } catch { /* idempotent */ }
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    if (newPassword.length < 8 || newPassword.length > 128) throw new BadRequestException("新密码需为 8–128 位");
    if (currentPassword === newPassword) throw new BadRequestException("新密码不能与当前密码相同");
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !(await argon2.verify(user.passwordHash, currentPassword))) throw new BadRequestException("当前密码不正确");
    const passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id });
    await this.prisma.$transaction(async tx => {
      const changed = await tx.user.updateMany({ where: { id: userId, passwordHash: user.passwordHash }, data: { passwordHash, authVersion: { increment: 1 } } });
      if (!changed.count) throw new ConflictException("密码已发生变化，请重新登录");
      await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    });
    writeLog({ userId, category: "OPERATION", operation: "auth.password", status: "COMPLETED" });
    return { ok: true };
  }

  private async issue(id: string, username: string, version: number) {
    const accessToken = await this.accessJwt.signAsync({ sub: id, id, username, version }, { expiresIn: "15m" });
    const jti = randomUUID();
    const refreshToken = await this.refreshJwt.signAsync({ sub: id, username, jti, version }, { expiresIn: "7d" });
    await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${id} FOR UPDATE`;
      const current = await tx.user.findUnique({where:{id},select:{authVersion:true}});
      if (!current || current.authVersion !== version) throw new UnauthorizedException("凭证已失效，请重新登录");
      await tx.refreshToken.create({ data: { id: jti, userId: id, tokenHash: this.hash(refreshToken), expiresAt: new Date(Date.now() + 7 * 86400_000) } });
    });
    return { user: { id, username }, accessToken, refreshToken };
  }

  private hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
}
