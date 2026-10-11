import { useState } from 'react';
import {
  MessageSquarePlus,
} from 'lucide-react';
import { Sheet } from '../../components/ui/Sheet';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import type { LlmChat } from '../../db/types';
import { removeChat } from '../../lib/ai/llmRepo';
import { modelLabel } from '../../lib/ai/models';
import { t } from '../../lib/i18n';
import { ICON } from '../../components/ui/icons';
import {
  GSearch as Search,
  GTrash as Trash2,
} from '../../components/ui/glyphs';

/** «26 июл, 18:40» — ISO-метка сообщения, а не дата-ключ (formatRu тут не подходит). */
function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface Props {
  open: boolean;
  chats: LlmChat[];
  activeId: string | null;
  onClose: () => void;
  onPick: (id: string) => void;
  onNew: () => void;
}

export function ChatListSheet({ open, chats, activeId, onClose, onPick, onNew }: Props) {
  const [query, setQuery] = useState('');

  async function handleRemove(chat: LlmChat) {
    if (!window.confirm(t('Удалить чат «{title}» со всей перепиской?', { title: chat.title }))) return;
    await removeChat(chat.id);
  }

  // Поиск по заголовку и превью последнего сообщения. Полный текст переписки
  // ищет глобальный поиск приложения — здесь нужен быстрый фильтр списка.
  const q = query.trim().toLowerCase();
  const shown = q
    ? chats.filter(
        (c) => c.title.toLowerCase().includes(q) || (c.lastMessageText ?? '').toLowerCase().includes(q),
      )
    : chats;

  return (
    <Sheet open={open} onClose={onClose} title={t('Чаты')}>
      <div className="space-y-2">
        <Button className="w-full inline-flex items-center justify-center gap-2" onClick={onNew}>
          <MessageSquarePlus size={ICON.base} />
          {t('Новый чат')}
        </Button>
        {chats.length > 5 && (
          <div className="relative">
            <Search size={ICON.action} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-lh-text-secondary" />
            <Input
              className="pl-9"
              placeholder={t('Поиск по чатам')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        )}
        {shown.map((c) => (
          <div
            key={c.id}
            className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 ${
              c.id === activeId ? 'border-lh-accent/40 bg-lh-accent-dim' : 'border-lh-border bg-lh-surface-2'
            }`}
          >
            <button className="min-w-0 flex-1 text-left active:opacity-60" onClick={() => onPick(c.id)}>
              <span className="block truncate font-medium">{c.title}</span>
              {/* У открытого чата подписи основным: серый на золотой подложке
                  поверх шторки — 4.40 в тёмной (канва design/muted-on-gold). */}
              {c.lastMessageText && (
                <span className={`mt-0.5 block truncate text-xs ${c.id === activeId ? 'text-lh-text-primary' : 'text-lh-text-secondary'}`}>
                  {c.lastMessageText}
                </span>
              )}
              <span className={`mt-0.5 block text-[0.68rem] ${c.id === activeId ? 'text-lh-text-primary' : 'text-lh-text-secondary'}`}>
                {formatWhen(c.lastMessageAt ?? c.createdAt)}
                {c.model !== 'echo' && ` · ${modelLabel(c.model)}`}
              </span>
            </button>
            <button
              aria-label={t('Удалить чат')}
              className="p-2 text-lh-text-secondary active:opacity-60"
              onClick={() => void handleRemove(c)}
            >
              <Trash2 size={ICON.base} />
            </button>
          </div>
        ))}
        {q && !shown.length && (
          <p className="py-4 text-center text-sm text-lh-text-secondary">{t('Ничего не нашлось')}</p>
        )}
      </div>
    </Sheet>
  );
}
