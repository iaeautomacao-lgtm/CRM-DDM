'use client';

import { PasswordForm } from './password-form';
import { SessionsCard } from './sessions-card';
import { SettingsPanelHead } from './settings-panel-head';

/**
 * "Login & security" section — groups the former Profile-tab password
 * and active-sessions cards into their own dedicated home.
 */
export function SecurityPanel() {
  return (
    <section className="max-w-2xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title="Login e segurança"
        description="Troque sua senha e desconecte seus dispositivos. Isso mantém sua conta segura."
      />
      <div className="space-y-4">
        <PasswordForm />
        <SessionsCard />
      </div>
    </section>
  );
}
