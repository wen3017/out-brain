import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";

test("password settings validate confirmation and require login with the new password", async ({ page, context }) => {
  let userId = "";
  const username = `account_${Date.now().toString(36)}`;
  try {
    await page.goto("/login");
    await page.getByRole("button", { name: "没有账号？立即注册" }).click();
    await page.getByLabel("用户名").fill(username);
    await page.getByLabel("密码", { exact: true }).fill("OriginalPassword123!");
    await page.getByRole("button", { name: "注册并登录" }).click();
    await expect(page.getByRole("heading", { name: "会话", exact: true })).toBeVisible();
    userId = await page.evaluate(() => JSON.parse(localStorage.getItem("nbboss-user")!).id);
    await page.getByRole("button", { name: "账号设置" }).click();
    await page.getByLabel("当前密码", { exact: true }).fill("OriginalPassword123!");
    await page.getByLabel("新密码", { exact: true }).fill("ChangedPassword123!");
    await page.getByLabel("确认新密码", { exact: true }).fill("MismatchPassword123!");
    await page.getByRole("button", { name: "修改密码", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText("两次输入的新密码不一致");
    await context.clearCookies({ name: "nbboss_access" });
    await page.getByLabel("确认新密码", { exact: true }).fill("ChangedPassword123!");
    await page.getByRole("button", { name: "修改密码", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("密码已修改，请重新登录。");
    await page.getByLabel("用户名").fill(username);
    await page.getByLabel("密码", { exact: true }).fill("ChangedPassword123!");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page.getByRole("heading", { name: "会话", exact: true })).toBeVisible();
  } finally {
    if (userId) execFileSync(process.execPath, ["e2e/fixture.cjs", "cleanup-user", Buffer.from(JSON.stringify({ userId })).toString("base64url")], { cwd: process.cwd(), env: process.env });
  }
});

test("a closed registration setting hides self-service signup", async ({ page }) => {
  await page.route("**/api/auth/options", route => route.fulfill({ json: { registrationEnabled: false } }));
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "登录", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "没有账号？立即注册" })).toHaveCount(0);
});
