import type { Request, Response, NextFunction } from "express";

export function requestSecurity(req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const origin = req.get("origin");
    if ((origin && origin !== process.env.WEB_ORIGIN) || req.get("sec-fetch-site") === "cross-site") {
      res.status(403).json({ message: "请求来源不被允许" }); return;
    }
  }
  next();
}
