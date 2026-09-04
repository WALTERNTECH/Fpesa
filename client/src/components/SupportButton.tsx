import { useApp } from '../store/app';
import { IconTelegram } from './Icons';

export function SupportButton(): JSX.Element {
  const { config } = useApp();

  return (
    <a
      className="support-fab"
      href={config.supportTelegram}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Contact Fpesa support on Telegram"
      title="Chat with Fpesa support on Telegram"
    >
      <IconTelegram size={22} />
      <span className="label">Support</span>
    </a>
  );
}
