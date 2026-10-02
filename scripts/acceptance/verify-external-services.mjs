import { createRequire } from 'node:module';
const require=createRequire(new URL('../../apps/api/package.json',import.meta.url));
const nodemailer=require('nodemailer');
const result={smtp:{configured:false,authenticated:false,enabled:process.env.SMTP_ENABLED==='true'},search:{configured:false,verified:false,enabled:process.env.SEARCH_ENABLED==='true'}};
if(process.env.SMTP_HOST&&process.env.SMTP_USER&&process.env.SMTP_PASSWORD){
 result.smtp.configured=true;
 const transport=nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT??465),secure:Number(process.env.SMTP_PORT??465)===465,auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASSWORD},connectionTimeout:15000,greetingTimeout:15000,socketTimeout:20000});
 try{await transport.verify();result.smtp.authenticated=true;}
 catch(error){result.smtp.error=['EAUTH','ETIMEDOUT','ECONNECTION','ESOCKET','EDNS'].includes(error.code)?error.code:'VERIFICATION_FAILED';}
 finally{transport.close();}
}
if(process.env.SEARCH_API_KEY){
 result.search.configured=true;
 try{
  const response=await fetch('https://api.tavily.com/search',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({api_key:process.env.SEARCH_API_KEY,query:'Tavily official documentation search API',max_results:1,search_depth:'basic'}),signal:AbortSignal.timeout(20000)});
  result.search.httpStatus=response.status;
  if(response.ok){const data=await response.json();result.search.verified=Array.isArray(data.results)&&data.results.some(item=>typeof item.url==='string'&&/^https?:\/\//.test(item.url));}
 }catch{result.search.error='CONNECTION_FAILED';}
}
console.log(JSON.stringify(result,null,2));
// This command verifies SMTP authentication only. It never sends a message.
