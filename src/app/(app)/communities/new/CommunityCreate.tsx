'use client';
import { useState } from 'react';
import { ApiForm } from '@/ui/ApiForm';

export function CommunityCreate({ hosts, platforms }: { hosts: { value: string; label: string }[]; platforms: { value: string; label: string }[] }) {
  const [picked, setPicked] = useState<string[]>([]);
  return (
    <div>
      <ApiForm endpoint="/api/communities" idempotent redirectTo="/communities/{id}" submitLabel="建立社群" testid="community-create-form" successMessage="社群已建立" extra={{ hostIds: picked }} fields={[
        { name: 'platform', label: '平台', type: 'select', required: true, defaultValue: 'LINE', options: platforms }, { name: 'name', label: '社群名稱', required: true },
        { name: 'url', label: '連結', type: 'url' }, { name: 'memberCount', label: '成員數', type: 'number', min: 0 }, { name: 'note', label: '備註', type: 'textarea' }]} />
      <h3 style={{ marginTop: 12 }}>所屬團主（選填，建立時一併連結）</h3>
      <div className="checks" data-testid="community-hosts">{hosts.length === 0 ? <span className="muted">尚無團主</span> : hosts.map((h) => (
        <label key={h.value}><input type="checkbox" checked={picked.includes(h.value)} onChange={(e) => setPicked((x) => e.target.checked ? [...x, h.value] : x.filter((y) => y !== h.value))} data-testid={`pick-host-${h.value}`} />{h.label}</label>))}</div>
    </div>
  );
}
