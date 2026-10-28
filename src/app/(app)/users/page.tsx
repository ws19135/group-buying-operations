import { withActor } from '@/server/ui/session';
import { listUsers } from '@/server/modules/auth';
import { hostOptions } from '@/server/ui/options';
import { vendorOptions } from '@/server/ui/options';
import { ActionButton } from '@/ui/ActionButton';
import { Card, EmptyState, PageHeader, StatusBadge, Table } from '@/ui/components';
import { ROLE_OPTIONS, USER_STATUS, roleLabel } from '@/ui/labels';
import { fmtDateTime } from '@/ui/format';
import { as } from '@/ui/types';
import { UserCreateForm } from './UserCreateForm';

export const dynamic = 'force-dynamic';
interface U { id: string; email: string; name: string; role: string; status: string; lastLoginAt: string | null; scopes: string[] }

export default withActor(async (actor) => {
  const users = as<U[]>(await listUsers(actor));
  const [hosts, vendors] = await Promise.all([hostOptions(actor), vendorOptions(actor)]);
  return (
    <>
      <PageHeader title="使用者" sub="僅系統管理者可管理。團主／廠商帳號必須綁定資料範圍" />
      <Card title="新增使用者"><UserCreateForm roles={ROLE_OPTIONS} hosts={hosts} vendors={vendors} /></Card>
      <Card flush testid="user-list">
        {users.length === 0 ? <EmptyState title="沒有使用者" /> : (
          <Table head={['姓名', 'Email', '角色', '資料範圍', '狀態', '最後登入', '']}>
            {users.map((u) => (
              <tr key={u.id} data-testid={`user-row-${u.id}`}><td><strong>{u.name}</strong><div className="small muted">{u.id}</div></td><td>{u.email}</td><td>{roleLabel(u.role)}</td><td className="small">{u.scopes.join('、') || '—'}</td><td><StatusBadge map={USER_STATUS} value={u.status} /></td><td className="small">{fmtDateTime(u.lastLoginAt)}</td>
                <td>{u.id !== actor.userId ? <ActionButton endpoint={`/api/users/${u.id}/status`} body={{ status: u.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' }} label={u.status === 'ACTIVE' ? '停用' : '啟用'} small variant={u.status === 'ACTIVE' ? 'danger' : ''} confirm={u.status === 'ACTIVE' ? '停用後此使用者會立即被登出且無法登入。' : undefined} testid={`btn-user-toggle-${u.id}`} /> : null}</td></tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
});
