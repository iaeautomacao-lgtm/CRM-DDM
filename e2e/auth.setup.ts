// Login de cada papel UMA vez (e-mail + senha + código TOTP quando a conta tem 2FA) e grava a sessão em e2e/.auth/.
// Só leitura: entra, nada além disso.
import { mkdirSync } from "node:fs";
import { expect, test as setup } from "@playwright/test";

import { authFile, credentialsFor, selectedRoles } from "./roles";
import { secondsLeft, totp } from "./totp";

mkdirSync("e2e/.auth", { recursive: true });

for (const r of selectedRoles()) {
  setup(`login ${r.label}`, async ({ page }) => {
    const cred = credentialsFor(r);
    await page.goto("/login");
    await page.locator("#email").fill(cred.email);
    await page.locator("#password").fill(cred.password);
    await page.locator('button[type="submit"]').click();

    // Vai para o painel (sem 2FA) ou para /login/2fa (fator TOTP verificado).
    await page.waitForURL((u) => u.pathname !== "/login", { timeout: 30_000 });

    if (new URL(page.url()).pathname === "/login/2fa") {
      if (!cred.totpSecret) {
        throw new Error(`${r.label} caiu em /login/2fa e ${r.envPrefix}_TOTP_SECRET não está definido.`);
      }
      const code = page.locator("#totp-code");
      await expect(code).toBeVisible({ timeout: 20_000 });
      // Duas tentativas: se o código está para expirar, espera a próxima janela para não falhar por relógio.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (secondsLeft() <= 3) await page.waitForTimeout((secondsLeft() + 1) * 1000);
        await code.fill(totp(cred.totpSecret));
        await page.locator('button[type="submit"]').click();
        const left = await page
          .waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15_000 })
          .then(() => true)
          .catch(() => false);
        if (left) break;
        if (attempt === 1) throw new Error(`${r.label}: o código TOTP foi recusado duas vezes (segredo errado ou relógio).`);
        await page.waitForTimeout((secondsLeft() + 1) * 1000);
      }
    }

    await expect(page).not.toHaveURL(/\/login/);
    await page.context().storageState({ path: authFile(r) });
  });
}
