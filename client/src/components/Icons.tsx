type IconProps = { size?: number; className?: string };

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
});

export function IconCheck({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export function IconShield({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

export function IconBolt({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

export function IconClose({ size = 18, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export function IconSend({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

export function IconWallet({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
      <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
      <path d="M18 12a2 2 0 0 0 0 4h4v-4z" />
    </svg>
  );
}

export function IconArrowDown({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <polyline points="19 12 12 19 5 12" />
    </svg>
  );
}

export function IconArrowUp({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  );
}

export function IconRefresh({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}

export function IconLogout({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

export function IconChart({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  );
}

export function IconDownload({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

export function IconChevron({ size = 14, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className} aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

/** Telegram paper-plane, used on the support button. */
export function IconTelegram({ size = 22, className }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M21.94 4.6l-3.02 14.25c-.23 1.01-.83 1.26-1.68.78l-4.64-3.42-2.24 2.16c-.25.25-.46.46-.94.46l.33-4.73L18.36 6.4c.37-.33-.08-.51-.58-.18L6.15 13.5l-4.7-1.47c-1.02-.32-1.04-1.02.21-1.51l18.4-7.09c.85-.31 1.6.2 1.32 1.17z" />
    </svg>
  );
}

/** The blue app mark that sits beside the wordmark. */
export function BrandMark({ size = 20 }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 16.5L9.5 11l3.2 3.4L19 6.5"
        stroke="#fff"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="19" cy="6.5" r="2" fill="#fff" />
    </svg>
  );
}
