import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  CircleAlert,
  ArrowDown,
  ArrowUp,
  Database,
  MessageSquarePlus,
  PanelsTopLeft,
  SlidersHorizontal,
  Square,
} from 'lucide-react';
import { Screen } from '../../components/layout/Screen';
import { useToast } from '../../components/ui/toastContext';
import {
  GSparkle,
  GChevronDown as ChevronDown,
  GCopy as Copy,
  GRepeat as RotateCcw,
} from '../../components/ui/glyphs';
import { IconButton } from '../../components/ui/IconButton';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';
import { ICON } from '../../components/ui/icons';
import type { LlmChat, LlmMessage } from '../../db/types';
import { aiErrorText } from '../../lib/ai/aiClient';
import { runAgent } from '../../lib/ai/agentLoop';
import { TOOL_LABELS } from '../../lib/ai/tools';
import { formatCost, modelLabel } from '../../lib/ai/models';
import {
  addAssistantMessage,
  addErrorMessage,
  addUserMessage,
  chatMessages,
  createChat,
  listChats,
  patchChat,
  removeMessage,
  toContext,
} from '../../lib/ai/llmRepo';
import { t } from '../../lib/i18n';
import { Markdown } from './Markdown';
import { ChatListSheet } from './ChatListSheet';
import { ChatSettingsSheet } from './ChatSettingsSheet';
import { ModelSheet } from './ModelSheet';

// Акцент раздела — клай Claude Code. Перекрываем только акцентные переменные на
// обёртке, как это делает FocusPage: нейтрали приложения остаются общими.
const CC_THEME: CSSProperties = {
  '--app-accent': 'var(--cc-accent)',
  '--app-accent-2': 'var(--cc-accent-2)',
} as CSSProperties;

export function AiPage() {
  const toast = useToast();
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  // Текст, печатающийся прямо сейчас. Живёт в React-состоянии, а НЕ в Dexie:
  // запись чанков в наблюдаемую таблицу перечитывала бы весь чат дважды в
  // секунду (§4.1 плана). null — стрима нет; '' — ждём первый токен.
  const [streamText, setStreamText] = useState<string | null>(null);
  // Имя инструмента, который исполняется прямо сейчас, — строка «читаю…».
  const [toolLabel, setToolLabel] = useState<string | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  // Кнопка «вниз к последнему» — появляется, когда лента прокручена вверх.
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const creating = useRef(false);

  // БЕЗ значения по умолчанию: undefined = «ещё грузится», [] = «чатов нет».
  // С дефолтом [] эти состояния неразличимы, и эффект ниже успевал завести
  // лишний пустой чат до того, как подтянутся существующие.
  const chats = useLiveQuery(() => listChats(), []);
  const list = chats ?? [];
  // Активный чат — производное значение, а НЕ состояние, выставленное из
  // эффекта: синхронный setState в эффекте даёт каскадные рендеры.
  const chat = (pickedId ? list.find((c) => c.id === pickedId) : null) ?? list[0] ?? null;
  const chatId = chat?.id ?? null;
  const messages = useLiveQuery(
    () => (chatId ? chatMessages(chatId) : Promise.resolve([])),
    [chatId],
    [] as LlmMessage[],
  );

  // Пустой раздел: заводим первый чат. Запись идёт в Dexie — внешнюю систему,
  // результат придёт через useLiveQuery, поэтому setState здесь не нужен.
  // Флаг-страховка от повторного создания, пока запрос не завершился.
  useEffect(() => {
    if (chats === undefined || chats.length || creating.current) return;
    creating.current = true;
    void createChat().finally(() => {
      creating.current = false;
    });
  }, [chats]);

  // Автоскролл к последнему сообщению. 'auto', а не 'smooth': плавная прокрутка
  // на каждый ответ на iOS конфликтует с инерцией и дёргает ленту.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, busy, streamText]);

  // Отмена запроса при уходе с экрана — иначе платим за токены впустую и
  // пишем в состояние размонтированного компонента.
  useEffect(() => () => abortRef.current?.abort(), []);

  /** Общий прогон: история текущего чата → цикл агента → запись ответа.
   *  Един для отправки и повтора — прежде логика жила в двух копиях. */
  async function runTurn(target: LlmChat) {
    setBusy(true);
    setStreamText('');
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const history = toContext(await chatMessages(target.id));
      const reply = await runAgent({
        messages: history,
        systemPrompt: target.systemPrompt,
        model: target.model,
        signal: ac.signal,
        dataTools: target.dataTools !== false,
        onDelta: (piece) => {
          setToolLabel(null);
          setStreamText((prev) => (prev ?? '') + piece);
        },
        onTool: (label) => setToolLabel(label),
      });
      // Поток гасим ДО записи в базу. Иначе между «ответ сохранён» и
      // «finally снял busy» лента показывает его дважды: сохранённым
      // сообщением и всё ещё живым потоком. Человек видит короткое двоение,
      // а на медленной машине окно достаточно заметное, чтобы в него попадал
      // и глаз, и тест.
      setStreamText(null);
      await addAssistantMessage(target.id, reply);
    } catch (e) {
      await addErrorMessage(target.id, aiErrorText(e));
    } finally {
      abortRef.current = null;
      setBusy(false);
      setStreamText(null);
      setToolLabel(null);
      inputRef.current?.focus();
    }
  }

  /** Отправка. textArg — программная (чипы-подсказки, «Продолжить»). */
  async function handleSend(textArg?: string) {
    const text = (textArg ?? draft).trim();
    if (!text || busy || !chat) return;
    if (!textArg) setDraft('');
    await addUserMessage(chat, text);
    await runTurn(chat);
  }

  /** Повтор: снимаем прошлый ответ и спрашиваем заново тем же контекстом. */
  async function handleRetry(m: LlmMessage) {
    if (busy || !chat) return;
    await removeMessage(m.id);
    await runTurn(chat);
  }

  async function handleNewChat() {
    // Новый чат наследует модель текущего: выбранная один раз живая модель
    // не должна откатываться к заглушке на каждом «＋».
    const c = await createChat(chat?.model);
    setPickedId(c.id);
    setListOpen(false);
    setDraft('');
  }

  // Стоимость чата на первом же экране (§3 плана): сумма снимков costRub.
  const chatCost = messages.reduce((sum, m) => sum + (m.costRub ?? 0), 0);

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast(t('Скопировано'));
    } catch {
      toast(t('Не удалось скопировать'));
    }
  }

  /** Показ кнопки «вниз»: далеко ли лента от последнего сообщения. */
  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    setAwayFromBottom(el.scrollHeight - el.scrollTop - el.clientHeight > 400);
  }

  return (
    <div style={CC_THEME} className="h-full">
      <Screen
        title={chat?.title ?? t('ИИ')}
        subtitle={chatCost > 0 ? t('за чат: {cost}', { cost: formatCost(chatCost) }) : undefined}
        backTo="/home"
        fill
        right={
          // gap-4: у IconButton -mx-1 и зона касания 44 — при gap-1 центры
          // соседей стояли в 32px, и зоны налезали друг на друга на 12px.
          <div className="flex items-center gap-4">
            <IconButton icon={SlidersHorizontal} label={t('Настройки чата')} onClick={() => setSettingsOpen(true)} />
            <IconButton icon={PanelsTopLeft} label={t('Список чатов')} onClick={() => setListOpen(true)} />
            <IconButton icon={MessageSquarePlus} label={t('Новый чат')} onClick={() => void handleNewChat()} />
          </div>
        }
      >
        <div className="relative flex h-full min-h-0 flex-col">
          <div ref={scrollRef} onScroll={handleScroll} className="min-h-0 flex-1 space-y-4 overflow-y-auto pb-3">
            {!messages.length && !busy && <AiWelcome onAsk={(q) => void handleSend(q)} />}
            {messages.map((m) =>
              m.role === 'user' ? (
                <UserBubble key={m.id} message={m} />
              ) : (
                <AssistantBlock
                  key={m.id}
                  message={m}
                  onCopy={() => void copyText(m.content)}
                  onRetry={() => void handleRetry(m)}
                  onContinue={() => void handleSend(t('Продолжи с места обрыва.'))}
                  busy={busy}
                />
              ),
            )}
            {busy && streamText ? <StreamingBlock text={streamText} /> : null}
            {busy && toolLabel ? (
              <ToolLine label={toolLabel} />
            ) : busy && !streamText ? (
              <Thinking />
            ) : null}
            <div ref={bottomRef} />
          </div>

          {awayFromBottom && (
            <button
              aria-label={t('К последнему сообщению')}
              className="absolute right-3 bottom-40 z-10 grid size-10 place-items-center rounded-full border border-hairline bg-elevated text-accent shadow-[var(--shadow-card)] active:opacity-70"
              onClick={() => bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })}
            >
              <ArrowDown size={ICON.header} />
            </button>
          )}

          <Composer
            ref={inputRef}
            value={draft}
            busy={busy}
            modelName={modelLabel(chat?.model ?? null) || t('Модель')}
            dataTools={chat?.dataTools !== false}
            onModelTap={() => setModelOpen(true)}
            onDataTools={(v) => chat && void patchChat(chat.id, { dataTools: v })}
            onChange={setDraft}
            onSend={() => void handleSend()}
            onStop={() => abortRef.current?.abort()}
          />
        </div>
      </Screen>

      <ChatListSheet
        open={listOpen}
        chats={list}
        activeId={chatId}
        onClose={() => setListOpen(false)}
        onPick={(id) => {
          setPickedId(id);
          setListOpen(false);
        }}
        onNew={() => void handleNewChat()}
      />
      {chat && (
        <ChatSettingsSheet
          key={chat.id}
          open={settingsOpen}
          chat={chat}
          onClose={() => setSettingsOpen(false)}
          onRemoved={() => {
            setSettingsOpen(false);
            setPickedId(null);
          }}
        />
      )}
      <ModelSheet
        open={modelOpen}
        value={chat?.model ?? 'echo'}
        onClose={() => setModelOpen(false)}
        onPick={(id) => chat && void patchChat(chat.id, { model: id })}
      />
    </div>
  );
}

/** Быстрые вопросы пустого чата: человек не обязан выдумывать, что умеет
 *  ассистент, — примеры показывают сразу и отправляются одним тапом. */
const SUGGESTIONS = [
  'Разбери мои расходы за месяц',
  'Что у меня по задачам на этой неделе?',
  'Собери план на завтра из моих задач',
  'Что просело по привычкам за месяц?',
];

function AiWelcome({ onAsk }: { onAsk: (q: string) => void }) {
  return (
    <div className="flex flex-col items-center px-4 pt-10 text-center">
      <div
        aria-hidden
        className="mb-4 grid size-16 place-items-center rounded-[1.25rem] text-white shadow-[var(--shadow-accent)]"
        style={{ background: 'linear-gradient(150deg, var(--app-accent), var(--app-accent-2))' }}
      >
        <GSparkle size={ICON.display} />
      </div>
      <p className="text-lg font-bold tracking-tight">{t('Спросите о своём')}</p>
      <p className="mt-1 mb-5 max-w-[17rem] text-sm text-muted">
        {t('Ассистент читает ваши задачи, заметки, финансы и привычки — и отвечает по фактам.')}
      </p>
      <div className="flex w-full max-w-sm flex-col gap-2">
        {SUGGESTIONS.map((q) => (
          <button
            key={q}
            className="rounded-2xl border border-hairline bg-surface-2 px-4 py-3 text-left text-sm active:opacity-70"
            onClick={() => onAsk(t(q))}
          >
            {t(q)}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Вопрос — пузырь справа. Ответ пузырём не оформляем: в Claude Code это поток
 *  на всю ширину, и такая асимметрия узнаётся сразу. */
function UserBubble({ message }: { message: LlmMessage }) {
  return (
    <div className="cc-msg-in flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-surface-2 px-3.5 py-2.5 whitespace-pre-wrap">
        {message.content}
      </div>
    </div>
  );
}

function AssistantBlock({
  message,
  onCopy,
  onRetry,
  onContinue,
  busy,
}: {
  message: LlmMessage;
  onCopy: () => void;
  onRetry: () => void;
  onContinue: () => void;
  busy: boolean;
}) {
  const failed = message.status === 'error';
  const cost = formatCost(message.costRub);
  return (
    <div className="cc-msg-in grid grid-cols-[1.25rem_1fr] gap-x-1">
      <div aria-hidden className="pt-2">
        <span className={`block size-1.5 rounded-full ${failed ? 'bg-danger' : 'bg-accent'}`} />
      </div>
      <div className="min-w-0">
        {failed ? (
          // Ошибка — карточка с действием, а не строка мелким шрифтом:
          // видно, что случилось, и что можно сделать прямо здесь.
          <div className="rounded-xl border border-danger/25 bg-danger/10 px-3.5 py-3">
            <p className="flex items-start gap-2 text-sm">
              <CircleAlert size={ICON.action} className="mt-0.5 shrink-0 text-danger" />
              <span className="min-w-0">{message.error}</span>
            </p>
            <button
              className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-danger/15 px-3 py-1.5 text-sm font-medium text-danger active:opacity-70 disabled:opacity-40"
              disabled={busy}
              onClick={onRetry}
            >
              <RotateCcw size={ICON.inline} />
              {t('Повторить')}
            </button>
          </div>
        ) : message.finishReason === 'content_filter' && !message.content.trim() ? (
          // Отказ приходит HTTP 200 с пустым содержимым (§4.6) — без этой
          // ветки на экране висел бы пустой блок со статусом «готово».
          <p className="text-sm text-muted">{t('Модель отклонила запрос.')}</p>
        ) : (
          <Markdown text={message.content} />
        )}
        {!failed && !!message.toolTrace?.length && (
          // След вызовов: что модель читала для этого ответа. Прозрачность —
          // часть фичи: видно, на каких данных построен ответ.
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {message.toolTrace.map((tr, i) => (
              <span
                key={i}
                className="rounded-md bg-accent/10 px-1.5 py-0.5 font-mono text-[0.68rem] text-accent"
              >
                {t(TOOL_LABELS[tr.tool] ?? tr.tool)} · {tr.count}
              </span>
            ))}
          </div>
        )}
        {!failed && message.finishReason === 'length' && (
          <div className="mt-1.5 flex items-center gap-2.5">
            <p className="text-xs text-warning">{t('Ответ обрезан лимитом токенов.')}</p>
            <button
              className="rounded-lg bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent active:opacity-70 disabled:opacity-40"
              disabled={busy}
              onClick={onContinue}
            >
              {t('Дописать')}
            </button>
          </div>
        )}
        <div className="mt-1.5 flex items-center gap-3 font-mono text-[0.7rem] text-muted">
          {!failed && message.tokensIn !== null && (
            <span>
              {message.tokensIn}→{message.tokensOut}
              {cost && ` · ${cost}`}
            </span>
          )}
          {!failed && message.model && <span className="truncate">{modelLabel(message.model)}</span>}
          {!failed && (
            <button aria-label={t('Скопировать')} className={`p-1 active:opacity-60 ${HIT_SLOP_44}`} onClick={onCopy}>
              <Copy size={ICON.inline} />
            </button>
          )}
          <button
            aria-label={t('Повторить')}
            className={`p-1 active:opacity-60 disabled:opacity-30 ${HIT_SLOP_44}`}
            disabled={busy}
            onClick={onRetry}
          >
            <RotateCcw size={ICON.inline} />
          </button>
        </div>
      </div>
    </div>
  );
}

/** Печатающийся ответ. Тот же вид, что готовый блок, но без метаданных;
 *  в конце — мигающая каретка, фирменный знак терминала. */
function StreamingBlock({ text }: { text: string }) {
  return (
    <div className="grid grid-cols-[1.25rem_1fr] gap-x-1">
      <div aria-hidden className="pt-2">
        <span className="block size-1.5 animate-pulse rounded-full bg-accent" />
      </div>
      <div className="min-w-0">
        <Markdown text={text} />
        <span aria-hidden className="cc-caret" />
      </div>
    </div>
  );
}

function Thinking() {
  return (
    <div className="grid grid-cols-[1.25rem_1fr] gap-x-1">
      <div aria-hidden className="pt-2">
        <span className="block size-1.5 animate-pulse rounded-full bg-accent" />
      </div>
      <p className="font-mono text-xs text-muted">{t('думает…')}</p>
    </div>
  );
}

/** Исполняется инструмент: «читаю Задачи…» вместо безликого «думает». */
function ToolLine({ label }: { label: string }) {
  return (
    <div className="grid grid-cols-[1.25rem_1fr] gap-x-1">
      <div aria-hidden className="pt-2">
        <span className="block size-1.5 animate-pulse rounded-full bg-accent" />
      </div>
      <p className="font-mono text-xs text-muted">
        {t('читаю:')} <span className="text-accent">{t(label)}</span>…
      </p>
    </div>
  );
}

interface ComposerProps {
  value: string;
  busy: boolean;
  modelName: string;
  dataTools: boolean;
  onModelTap: () => void;
  onDataTools: (v: boolean) => void;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  ref?: React.Ref<HTMLTextAreaElement>;
}

function Composer({ value, busy, modelName, dataTools, onModelTap, onDataTools, onChange, onSend, onStop, ref }: ComposerProps) {
  return (
    // Один плотный блок вместо двух полупустых строк: поле во всю ширину,
    // под ним слева модель и доступ к данным, справа отправка. Ни одного
    // элемента, висящего в воздухе, — каждый угол занят делом.
    <div className="shrink-0 border-t border-hairline pt-2 pb-[calc(env(safe-area-inset-bottom)+8px)]">
      <textarea
        ref={ref}
        value={value}
        rows={1}
        placeholder={t('Сообщение…')}
        className="max-h-40 min-h-11 w-full resize-none rounded-2xl bg-surface-2 px-3.5 py-2.5 outline-none transition-[box-shadow] focus-visible:ring-2 focus-visible:ring-accent/60"
        onChange={(e) => {
          onChange(e.target.value);
          // Авторост: сбрасываем высоту перед замером, иначе поле не сжимается.
          e.target.style.height = 'auto';
          e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
        }}
        onKeyDown={(e) => {
          // Enter отправляет только с курсором и физической клавиатурой:
          // на телефоне это перевод строки, иначе писать многострочное нельзя.
          if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(pointer: fine)').matches) {
            e.preventDefault();
            onSend();
          }
        }}
      />
      <div className="mt-2 flex items-center gap-1.5">
        {/* Модель — у поля ввода, а не в настройках: смена посреди диалога
            законна (дальше отвечает новая) и запоминается в самом чате.
            Пилюля вместо системного select: тап открывает шит с ценами и
            пояснениями — выбор становится осмысленным, а не слепым. */}
        <button
          aria-label={t('Модель')}
          disabled={busy}
          className={`inline-flex min-w-0 items-center gap-1 rounded-full border border-hairline bg-surface-2 py-1.5 pr-2 pl-3 text-[0.82rem] font-medium active:opacity-70 disabled:opacity-50 ${HIT_SLOP_44}`}
          onClick={onModelTap}
        >
          <span className="truncate">{modelName}</span>
          <ChevronDown size={ICON.inline} className="shrink-0 text-muted" />
        </button>
        {/* Доступ модели к данным приложения. Включён по умолчанию — это и
            есть смысл раздела; выключатель — для разговоров «не о своём». */}
        <button
          aria-label={t('Доступ к данным')}
          aria-pressed={dataTools}
          disabled={busy}
          className={`inline-flex shrink-0 items-center gap-1 rounded-full border py-1.5 pr-2.5 pl-2 text-[0.82rem] font-medium transition-colors ${HIT_SLOP_44} ${
            dataTools
              ? 'border-accent/30 bg-accent/12 text-accent'
              : 'border-hairline bg-surface-2 text-muted'
          }`}
          onClick={() => onDataTools(!dataTools)}
        >
          <Database size={ICON.inline} />
          {t('Данные')}
        </button>
        <div className="flex-1" />
        {busy ? (
          <button
            aria-label={t('Остановить')}
            className={`grid size-10 shrink-0 place-items-center rounded-full border border-hairline bg-surface-2 active:opacity-70 ${HIT_SLOP_44}`}
            onClick={onStop}
          >
            <Square size={ICON.action} />
          </button>
        ) : (
          <button
            aria-label={t('Отправить')}
            disabled={!value.trim()}
            className={`grid size-10 shrink-0 place-items-center rounded-full text-white transition-opacity active:opacity-80 disabled:opacity-30 ${HIT_SLOP_44}`}
            style={{
              background: 'var(--app-accent-fill)',
              boxShadow: 'var(--shadow-accent)',
            }}
            onClick={onSend}
          >
            <ArrowUp size={ICON.header} />
          </button>
        )}
      </div>
    </div>
  );
}
