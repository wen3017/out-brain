import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";

test("automatic search is the default; explicit modes survive in the request and failures retain the draft", async ({ page }) => {
  let userId = "";
  try {
    await page.goto("/login");
    await page.getByRole("button",{name:"没有账号？立即注册"}).click();
    await page.getByLabel("用户名").fill(`eval_${Date.now().toString(36)}`);
    await page.getByLabel("密码").fill("Evaluation123!");
    await page.getByRole("button",{name:"注册并登录"}).click();
    await expect(page.getByRole("heading",{name:"会话",exact:true})).toBeVisible();
    userId = await page.evaluate(()=>JSON.parse(localStorage.getItem("nbboss-user")!).id);
    await page.getByRole("button",{name:/普通对话/}).click();
    await expect(page.getByLabel("联网模式")).toHaveValue("auto");
    const modes: unknown[] = [];
    await page.route("**/api/conversations/*/messages", async route => {
      modes.push(route.request().postDataJSON().webSearch);
      await route.fulfill({status:200,contentType:"text/event-stream",body:`data: ${JSON.stringify({type:"run.failed",runId:"evaluation",message:"搜索服务未配置，未取得实时证据"})}\n\n`});
    });
    const input=page.getByPlaceholder("输入消息，Shift + Enter 换行");
    for (const mode of ["auto","off","on"]) {
      await page.getByLabel("联网模式").selectOption(mode);
      await input.fill("今天有哪些科技新闻？");
      await page.getByRole("button",{name:"发送消息",exact:true}).click();
      await expect(input).toHaveValue("今天有哪些科技新闻？");
      await expect(page.getByText("搜索服务未配置，未取得实时证据",{exact:true})).toBeVisible();
    }
    expect(modes).toEqual(["auto","off","on"]);
  } finally {
    if(userId) execFileSync(process.execPath,["e2e/fixture.cjs","cleanup-user",Buffer.from(JSON.stringify({userId})).toString("base64url")],{cwd:process.cwd(),env:process.env});
  }
});
