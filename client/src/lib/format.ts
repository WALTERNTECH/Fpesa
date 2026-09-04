const kesFormatter = new Intl.NumberFormat('en-KE', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const kesWhole = new Intl.NumberFormat('en-KE', { maximumFractionDigits: 0 });

/** KSh 12,450.00 — the platform's money format everywhere. */
export function ksh(value: number, whole = false): string {
  const n = Number.isFinite(value) ? value : 0;
  return 'KSh ' + (whole ? kesWhole.format(n) : kesFormatter.format(n));
}

export function kshShort(value: number): string {
  const n = Math.abs(value);
  if (n >= 1_000_000) return 'KSh ' + (value / 1_000_000).toFixed(1) + 'M';
  if (n >= 10_000) return 'KSh ' + (value / 1000).toFixed(0) + 'K';
  return ksh(value, true);
}

export function signed(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return sign + kesFormatter.format(Math.abs(value));
}

/** Gold quotes carry two decimals; keep the digit count stable so it never jumps. */
export function price(value: number): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function timeAgo(iso: string): string {
  const diff = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diff)) return '';
  const s = Math.max(Math.floor(diff / 1000), 0);
  if (s < 10) return 'just now';
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

export function clockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function initials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

/** 0712 345 678 — how a Kenyan number reads on a receipt. */
export function displayPhone(phone: string): string {
  const local = phone.startsWith('254') ? '0' + phone.slice(3) : phone;
  if (local.length !== 10) return phone;
  return local.slice(0, 4) + ' ' + local.slice(4, 7) + ' ' + local.slice(7);
}

export function durationLabel(seconds: number): string {
  return seconds >= 60 ? seconds / 60 + 'm' : seconds + 's';
}
