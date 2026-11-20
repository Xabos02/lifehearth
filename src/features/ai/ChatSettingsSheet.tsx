import { useState } from 'react';
import { Sheet } from '../../components/ui/Sheet';
import { Button } from '../../components/ui/Button';
import { Input, Textarea } from '../../components/ui/Input';
import { SegmentedControl } from '../../components/ui/SegmentedControl';
import { useToast } from '../../components/ui/toastContext';
import type { LlmChat } from '../../db/types';
import { chatMessages, chatTitle, exportChatMarkdown, patchChat, removeChat } from '../../lib/ai/llmRepo';
import { stopTurn } from '../../lib/ai/turns';
import { t } from '../../lib/i18n';
import { ICON } from '../../components/ui/icons';
import { GFaDatabase, GFaFileArrowDown, GFaTrashCan } from '../../components/ui/glyphs';
import { confirmAction } from '../../components/ui/confirmStore';

interface Props {
  open: boolean;
  chat: LlmChat;
  onClose: () => void;
  /** Чат удалён — родителю пора переключиться на соседний. */
  onRemoved: () => void;
}

/** Настройки одного чата: имя, инструкция модели, доступ к данным, экспорт,
 *  удаление. Модель здесь НЕ живёт — она в композере, у места разговора. */
export function ChatSettingsSheet({ open, chat, onClose, onRemoved }: Props) {
  const toast = useToast();
  // key-remount от родителя при смене чата — инициализация состоянием
  // пропсов здесь законна (тот же паттерн, что RenameSheet семьи).
  // Поле — в языке интерфейса, а хранится служебная строка «Новый чат»
  // (по ней даётся автоназвание): неизменённое поле её и оставляет.
  const [title, setTitle] = useState(chatTitle(chat));
  const [prompt, setPrompt] = useState(chat.systemPrompt);

  async function handleSave() {
    await patchChat(chat.id, {
      title: title.trim() && title.trim() !== chatTitle(chat) ? title.trim() : chat.title,
      systemPrompt: prompt.trim(),
    });
    onClose();
  }

  async function handleExport() {
    const md = exportChatMarkdown(chat, await chatMessages(chat.id));
    const safe = chatTitle(chat).replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'chat';
    const file = new File([md], `${safe}.md`, { type: 'text/markdown' });
    // Тот же путь, что у отчёта статистики: iOS — share-шит (дорога в
    // «Файлы»), остальные — прямое скачивание.
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    if (isIOS && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          toast(t('Не удалось поделиться. Попробуйте ещё раз'));
        }
        return;
      }
    } else {
      const url = URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      a.click();
      URL.revokeObjectURL(url);
    }
    toast(t('Диалог экспортирован'));
  }

  async function handleRemove() {
    if (!(await confirmAction(t('Удалить чат «{title}» со всей перепиской?', { title: chatTitle(chat) })))) return;
    stopTurn(chat.id);
    await removeChat(chat.id);
    onRemoved();
  }

  return (
    <Sheet open={open} onClose={onClose} title={t('Настройки чата')}>
      <div className="space-y-5">
        <label className="block">
          <span className="mb-1.5 block text-sm text-lh-text-secondary">{t('Название')}</span>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-sm text-lh-text-secondary">{t('Инструкция для модели')}</span>
          <Textarea
            rows={3}
            placeholder={t('Например: отвечай кратко, в два-три предложения')}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <span className="mt-1 block text-xs text-lh-text-secondary">
            {t('Действует на все ответы в этом чате.')}
          </span>
        </label>

        <div className="space-y-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <GFaDatabase size={ICON.inline} className="shrink-0 text-lh-accent" />
            <div className="min-w-0">
              <p className="font-medium">{t('Доступ к данным')}</p>
              <p className="text-xs text-lh-text-secondary">
                {t('Когда включён, модель читает задачи, заметки, финансы, привычки, цели, обучение и энергию.')}
              </p>
            </div>
          </div>
          <SegmentedControl
            options={[
              { value: 'on', label: t('Включён') },
              { value: 'off', label: t('Выключен') },
            ]}
            value={chat.dataTools === true ? 'on' : 'off'}
            onChange={(v) => void patchChat(chat.id, { dataTools: v === 'on' })}
          />
        </div>

        <div className="space-y-2">
          <Button variant="secondary" className="w-full" onClick={() => void handleExport()}>
            <GFaFileArrowDown size={ICON.inline} />
            {t('Экспорт в markdown')}
          </Button>
          <Button className="w-full" onClick={() => void handleSave()}>
            {t('Сохранить')}
          </Button>
          <button
            className="w-full py-2.5 text-center text-sm text-danger active:opacity-60"
            onClick={() => void handleRemove()}
          >
            <GFaTrashCan size={ICON.inline} className="mr-1.5 inline-block align-[-2px]" />
            {t('Удалить чат')}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
