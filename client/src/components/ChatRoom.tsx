import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { marketSocket } from '../lib/ws';
import { useApp } from '../store/app';
import { clockTime, initials } from '../lib/format';
import { IconSend } from './Icons';
import type { ChatMessage } from '../lib/types';

export function ChatRoom(): JSX.Element {
  const { user, openModal, online } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.get<{ messages: ChatMessage[] }>('/social/chat');
        if (!cancelled) setMessages(res.messages);
      } catch {
        // Empty room is an acceptable failure mode here.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return marketSocket.on((msg) => {
      if (msg.type !== 'chat') return;
      setMessages((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev;
        // Cap the room so a long session cannot grow the DOM without bound.
        return [...prev, {
          id: msg.id,
          username: msg.username,
          body: msg.body,
          createdAt: msg.createdAt,
        }].slice(-120);
      });
    });
  }, []);

  // Follow new messages, but never yank the view while someone reads history.
  useEffect(() => {
    if (pinnedToBottom.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages]);

  const onScroll = (): void => {
    const el = listRef.current;
    if (!el) return;
    pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  const send = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;

    setSending(true);
    setError(null);
    try {
      await api.post('/social/chat', { body });
      setDraft('');
      pinnedToBottom.current = true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send your message.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <div className="section-title">
          <span className="dot" />
          Trader chat
        </div>
        <span className="eyebrow">{online > 0 ? online + ' online' : 'Public room'}</span>
      </div>

      <div className="scroll-area" ref={listRef} onScroll={onScroll}>
        {messages.length === 0 ? (
          <div className="empty">No messages yet — say hello to the desk.</div>
        ) : (
          <div className="chat-list">
            {messages.map((m) => {
              const mine = user?.username === m.username;
              return (
                <div className="chat-msg" key={m.id}>
                  <span className={'avatar' + (mine ? ' self' : '')}>
                    {initials(m.username)}
                  </span>
                  <div className="body">
                    <div className="who">
                      <span className="n">{mine ? 'You' : m.username}</span>
                      <span className="t tnum">{clockTime(m.createdAt)}</span>
                    </div>
                    <div className="txt">{m.body}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {user ? (
        <form className="chat-form" onSubmit={(e) => void send(e)}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Message the trading floor…"
            maxLength={400}
            aria-label="Chat message"
          />
          <button
            className="btn btn-primary btn-sm"
            type="submit"
            disabled={sending || draft.trim() === ''}
            aria-label="Send message"
          >
            <IconSend size={15} />
          </button>
        </form>
      ) : (
        <div className="chat-locked">
          <button className="btn btn-ghost btn-sm" onClick={() => openModal('login')}>
            Log in to join the conversation
          </button>
        </div>
      )}

      {error && (
        <div style={{ padding: '0 14px 12px' }}>
          <div className="panel-error" style={{ marginTop: 0 }}>
            {error}
          </div>
        </div>
      )}
    </div>
  );
}
