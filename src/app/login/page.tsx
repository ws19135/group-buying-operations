import { redirect } from 'next/navigation';
import { getActor } from '@/server/ui/session';
import { LoginForm } from './LoginForm';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  if (await getActor()) redirect('/');
  return (
    <div className="login-box">
      <div className="card">
        <h1 style={{ marginBottom: 4 }}>🛒 團購 ERP</h1>
        <p className="muted" style={{ marginTop: 0 }}>請使用公司提供的帳號登入</p>
        <LoginForm />
      </div>
    </div>
  );
}
