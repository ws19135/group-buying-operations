import { redirect } from 'next/navigation';
import { requireActor } from '@/server/ui/session';
import { PasswordForm } from './PasswordForm';

export const dynamic = 'force-dynamic';

/** 變更密碼頁（初次啟用時強制；之後也可自行變更）。不在 (app) 版型內，避免被「必須先變更密碼」的導頁擋住。 */
export default async function PasswordPage() {
  const actor = await requireActor({ allowPasswordChange: true });
  if (!actor) redirect('/login');
  return (
    <div className="login-box">
      <div className="card">
        <h1 style={{ marginBottom: 4 }}>變更密碼</h1>
        <p className="muted" style={{ marginTop: 0 }} data-testid="password-note">
          {actor.mustChangePassword ? '這是初次啟用（或密碼已被重設）：請先設定自己的新密碼，才能使用系統。' : '請輸入目前密碼與新密碼。'}
        </p>
        <PasswordForm forced={!!actor.mustChangePassword} />
      </div>
    </div>
  );
}
