'use client';
import { useRef, type ReactNode } from 'react';

/** 原生 <dialog> 對話框。trigger 按鈕開啟；children 內可呼叫 close() 關閉（透過 render prop） */
export function Modal({ label, title, children, variant = '', size = 'btn', testid }: { label: string; title: string; children: ReactNode | ((close: () => void) => ReactNode); variant?: 'primary' | 'danger' | ''; size?: 'btn' | 'btn sm'; testid?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const close = () => ref.current?.close();
  return (
    <>
      <button type="button" className={`${size} ${variant}`.trim()} onClick={() => ref.current?.showModal()} data-testid={testid}>{label}</button>
      <dialog ref={ref} data-testid={testid ? `${testid}-dialog` : undefined}>
        <div className="dlg-head"><strong>{title}</strong><button type="button" className="btn sm" onClick={close} aria-label="關閉">✕</button></div>
        <div className="dlg-body">{typeof children === 'function' ? children(close) : children}</div>
      </dialog>
    </>
  );
}
