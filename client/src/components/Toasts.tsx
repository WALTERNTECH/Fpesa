import { useApp } from '../store/app';

export function Toasts(): JSX.Element | null {
  const { toasts } = useApp();
  if (toasts.length === 0) return null;

  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div className={'toast ' + t.tone} key={t.id}>
          <span className="ico" aria-hidden="true">
            {t.icon}
          </span>
          <div>
            <div className="t">{t.title}</div>
            {t.detail && <div className="d">{t.detail}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}
