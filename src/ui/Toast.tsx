'use client';
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

interface T { id: number; kind: 'ok' | 'error' | 'info'; text: string }
const Ctx = createContext<(kind: T['kind'], text: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<T[]>([]);
  const push = useCallback((kind: T['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs, { id, kind, text }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 3500);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="toast-wrap" aria-live="polite" data-testid="toasts">
        {items.map((t) => <div key={t.id} className={`toast ${t.kind}`} role="status" data-testid={`toast-${t.kind}`}>{t.text}</div>)}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
