import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { PrismaService } from "../../infra/prisma.service.js";

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly jwt = new JwtService({ secret: process.env.JWT_ACCESS_SECRET });
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const header = request.headers.authorization as string | undefined;
    const token = request.cookies?.nbboss_access ?? header?.replace(/^Bearer\s+/i, "");
    if (!token) throw new UnauthorizedException("请先登录");
    try {
      const payload = this.jwt.verify(token);
      const user = await this.prisma.user.findUnique({ where: { id: payload.sub }, select: { id: true, username: true, authVersion: true } });
      if (!user || user.authVersion !== (payload.version ?? 0)) throw new Error();
      request.user = { id: user.id, username: user.username };
      return true;
    } catch {
      throw new UnauthorizedException("登录已过期");
    }
  }
}
