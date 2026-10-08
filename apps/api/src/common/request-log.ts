import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { writeLog } from "./activity-log.js";

export function requestLog(req:Request,res:Response,next:NextFunction) {
  const started=Date.now();
  res.locals.traceId=randomUUID();
  res.setHeader("X-Request-Id",res.locals.traceId);
  res.once("finish",()=>{
    // Use the route template, never the URL/query string (which may hold secrets).
    const route=typeof req.route?.path==="string"?req.route.path:"unmatched";
    if(route.includes("/logs")||route.includes("/health"))return;
    if(req.method==="GET"&&res.statusCode<400)return;
    if(route.endsWith("/auth/refresh"))return;
    const user=(req as Request & {user?:{id:string}}).user;
    writeLog({userId:user?.id,category:"OPERATION",operation:`${req.method} ${route}`,status:res.statusCode>=400?"FAILED":"COMPLETED",
      level:res.statusCode>=500?"ERROR":res.statusCode>=400?"WARN":"INFO",traceId:res.locals.traceId,
      resourceId:typeof req.params.id==="string"?req.params.id:undefined,durationMs:Date.now()-started,httpStatus:res.statusCode,errorCode:res.locals.errorCode});
  });
  next();
}
