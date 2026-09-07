import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react';
import Dexie from 'dexie';
import { useLiveQuery } from 'dexie-react-hooks';
import type { LucideIcon } from 'lucide-react';
import { useLoaded } from '../../hooks/useLoaded';
import {
  ArrowRight,
  CheckCheck,
  ChevronsDown,
  Clock,
  Hand,
  Heart,
  Paperclip,
  Mic,
  Search as SearchIcon,
  LoaderCircle,
  Image as ImageIcon,
  File as FileIcon,
  FileText,
  FileArchive,
  FileSpreadsheet,
} from 'lucide-react';
import {
  GCheck as Check,
  GPencil as Pencil,
  GTrash as Trash2,
  GClose as X,
  GCopy as Copy,
  GSend as Send,
  GReply as Reply,
  GPlay as Play,
  GPause as Pause,
} from '../../components/ui/glyphs';
import { db } from '../../db/db';
import type { FamilyMessage } from '../../db/types';
import { Sheet } from '../../components/ui/Sheet';
import { Hint } from '../../components/ui/Hint';
import { getLang, t } from '../../lib/i18n';
import { useToast } from '../../components/ui/toastContext';
import {
  compressImage,
  ImageDecodeError,
  ImageTooLargeError,
  MAX_INPUT_BYTES,
} from '../../lib/image';
import { fileKindLabel, formatFileSize, MAX_FILE_BYTES } from '../../lib/family/fileTransfer';
import { isTouch } from '../../lib/platform';
import { getFamilyConfig } from '../../lib/family/familyState';
import { systemMessageText } from '../../lib/family/systemMessage';
import { linkify } from '../../lib/family/linkify';
import { clearDraft, loadDraft, saveDraft } from '../../lib/family/draft';
import { clearUndecrypted, subscribeUndecrypted, undecryptedCount } from '../../lib/family/undecrypted';
import { searchMessages, type SearchHit } from '../../lib/family/searchMessages';
import { setScreenAction } from '../../lib/ui/screenAction';
import {
  sendMessage,
  sendImage,
  sendAudio,
  sendFile,
  sendReaction,
  sendTyping,
  subscribeTyping,
  editMessage,
  deleteMessage,
  subscribeReads,
  subscribePresence,
  subscribeLastSeen,
  markSeen,
} from '../../lib/family/familyChat';
import { useVoiceRecorder } from './useVoiceRecorder';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';
import { ICON } from '../../components/ui/icons';

// Палитра быстрых реакций — как в WhatsApp/Telegram, шесть базовых.
const REACTIONS = ['❤️', '👍', '😂', '😮', '😢', '🔥'];

// Сколько сообщений держим в ленте и на сколько прибавляем при подъёме
// вверх. 60 — примерно три экрана: и открывается мгновенно, и «вчерашнее»
// уже под рукой без подгрузки.
const PAGE = 60;

// Сколько последних записей поднимаем из базы. Шире окна отрисовки: в тех же
// строках живут реакции и куски файлов, и запас держит их рядом с
// сообщениями, к которым они относятся. Дальше вглубь истории человек
// уходит подгрузкой, а не оплачивает её на каждом входящем сообщении.
const READ_WINDOW = 400;

/** мм:сс из секунд. */
function fmtDur(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Плеер голосового: play/pause + полоса прогресса + длительность. */
function AudioBubble({ src, duration, own }: { src: string; duration: number; own: boolean }) {
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const aRef = useRef<HTMLAudioElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const total = duration || pos || 1;

  /** Перемотка по координате касания на дорожке. */
  const seekTo = (clientX: number) => {
    const bar = barRef.current;
    const a = aRef.current;
    if (!bar || !a) return;
    const r = bar.getBoundingClientRect();
    if (!r.width) return;
    const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    // Длительность из метаданных точнее записанной в сообщении, но у файлов
    // из потоковой записи она бывает бесконечной — тогда верим сообщению.
    const dur = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : duration;
    if (!dur) return;
    a.currentTime = ratio * dur;
    setPos(a.currentTime);
  };
  return (
    <div className="flex min-w-[170px] items-center gap-2.5 py-0.5">
      <button
        onClick={(e) => {
          e.stopPropagation();
          const a = aRef.current;
          if (!a) return;
          if (a.paused) void a.play();
          else a.pause();
        }}
        aria-label={playing ? t('Пауза') : t('Воспроизвести')}
        className={`flex size-9 shrink-0 items-center justify-center rounded-full ${HIT_SLOP_44} ${own ? 'bg-white/20 text-white' : 'bg-accent/15 text-accent'}`}
      >
        {playing ? <Pause size={ICON.action} /> : <Play size={ICON.action} />}
      </button>
      {/* Полоса перематывает: голосовое на минуту без перемотки приходится
          слушать целиком, даже если нужен был конец. Дорожка тонкая, но зона
          касания вокруг неё — во всю высоту строки, иначе в неё не попасть
          пальцем. stopPropagation: иначе касание уходит в жесты пузыря
          (свайп-ответ, меню) и вместо перемотки открывается меню. */}
      <div
        ref={barRef}
        role="slider"
        tabIndex={0}
        aria-label={t('Перемотка')}
        aria-valuemin={0}
        aria-valuemax={Math.round(total)}
        aria-valuenow={Math.round(pos)}
        onPointerDown={(e) => {
          e.stopPropagation();
          e.currentTarget.setPointerCapture(e.pointerId);
          seekTo(e.clientX);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) seekTo(e.clientX);
        }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          const a = aRef.current;
          if (!a) return;
          if (e.key === 'ArrowRight') a.currentTime = Math.min(total, a.currentTime + 5);
          else if (e.key === 'ArrowLeft') a.currentTime = Math.max(0, a.currentTime - 5);
          else return;
          e.preventDefault();
          setPos(a.currentTime);
        }}
        className="flex flex-1 cursor-pointer touch-none items-center py-2"
      >
        <div className={`h-1 w-full overflow-hidden rounded-full ${own ? 'bg-white/25' : 'bg-hairline'}`}>
          <div className="h-full rounded-full bg-current" style={{ width: `${Math.min(100, (pos / total) * 100)}%` }} />
        </div>
      </div>
      <span className="shrink-0 text-2xs tabular-nums">{fmtDur(playing || pos ? pos : duration)}</span>
      <audio
        ref={aRef}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setPos(0);
        }}
        onTimeUpdate={(e) => setPos((e.target as HTMLAudioElement).currentTime)}
      />
    </div>
  );
}

/** Иконка по короткой подписи из fileKindLabel — 4 значка на 5 подписей
 *  («Документ PDF» и «Текст» делят FileText), остальное — общий File.
 *
 *  Реестр, а не функция с return: возврат компонента из вызова внутри рендера
 *  React считает созданием нового типа на каждый кадр (react-hooks/
 *  static-components), и карточка файла теряла бы поддерево при каждом
 *  обновлении списка сообщений. Тот же приём уже используется в разделе целей. */
const FILE_ICONS: Record<string, LucideIcon> = {
  'Архив': FileArchive,
  'Таблица': FileSpreadsheet,
  'Документ PDF': FileText,
  'Текст': FileText,
};

/** Карточка файла-манифеста: иконка типа, имя, подпись — тип+размер, когда
 *  файл на руках; прогресс сборки или «недоступен», пока нет. */
function FileBubble({ m, own, received }: { m: FamilyMessage; own: boolean; received: number }) {
  const info = m.file!;
  const Icon = FILE_ICONS[fileKindLabel(info.mime, info.name)] ?? FileIcon;
  const available = Boolean(m.fileData);
  // received===0 и своего fileData нет — либо чанки ещё даже не начали
  // приходить (маловероятно долго), либо это старая история и ретеншн
  // сервера (последние 5000 сообщений) их уже вытеснил. Не гадаем откуда —
  // просто честно говорим «недоступен», как и просили в задаче.
  const unavailable = !available && received === 0;
  const subtitle = available
    ? `${t(fileKindLabel(info.mime, info.name))} · ${formatFileSize(info.size)}`
    : unavailable
      ? t('Файл недоступен')
      : t('Получение {a} из {b}', { a: received, b: info.chunksTotal });
  return (
    <div className="flex min-w-[190px] max-w-[240px] items-center gap-2.5 py-0.5">
      <div
        className={`flex size-9 shrink-0 items-center justify-center rounded-full ${own ? 'bg-white/20 text-white' : 'bg-accent/15 text-accent'}`}
      >
        <Icon size={ICON.base} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{info.name}</p>
        <p className={`truncate text-2xs ${unavailable ? 'opacity-60' : ''} ${own ? 'text-white/70' : 'text-muted'}`}>
          {subtitle}
        </p>
      </div>
    </div>
  );
}

// Единый порядок сообщений: подтверждённые по seq, неотправленные — в конец
// по времени. Реакции и чанки файлов — служебные записи, в ленте не показываются.
function msgOrder(a: FamilyMessage, b: FamilyMessage): number {
  if (a.seq != null && b.seq != null) return a.seq - b.seq;
  if (a.seq == null && b.seq == null) return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  return a.seq == null ? 1 : -1;
}
function ordered(msgs: FamilyMessage[]): FamilyMessage[] {
  return [...msgs].filter((m) => !m.deletedAt && !m.reaction && !m.fileChunk).sort(msgOrder);
}

function timeLabel(iso: string): string {
  // Локаль как у разделителей дней: в английском интерфейсе время не должно
  // оставаться в русском формате.
  return new Date(iso).toLocaleTimeString(getLang() === 'ru' ? 'ru-RU' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** «Сегодня» / «Вчера» / «5 июля» — разделители дней в ленте. */
function dayLabel(iso: string, now: number): string {
  const d = new Date(iso);
  const today = new Date(now);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(today) - startOf(d)) / 86_400_000);
  if (diffDays === 0) return t('Сегодня');
  if (diffDays === 1) return t('Вчера');
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === today.getFullYear() ? { day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long', year: 'numeric' };
  return d.toLocaleDateString(getLang() === 'ru' ? 'ru-RU' : 'en-US', opts);
}
function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** «5 мин назад» / «2 ч назад» / «вчера» / «3 июн». now передаётся state'ом,
 *  чтобы не звать Date.now() в теле рендера (react-hooks/purity). */
function relTime(iso: string, now: number): string {
  const min = Math.floor((now - new Date(iso).getTime()) / 60000);
  if (min < 1) return t('только что');
  if (min < 60) return t('{m}\u00A0мин назад', { m: min });
  const h = Math.floor(min / 60);
  if (h < 24) return t('{h}\u00A0ч назад', { h });
  const d = Math.floor(h / 24);
  if (d === 1) return t('вчера');
  if (d < 7) return t('{d}\u00A0дн назад', { d });
  return new Date(iso).toLocaleDateString(getLang() === 'ru' ? 'ru-RU' : 'en-US', { day: 'numeric', month: 'short' });
}

/** Сообщение из одних эмодзи (1–3 графемы): рисуется без пузыря, крупно —
 *  как в больших мессенджерах. Сегментация по графемам, а не по кодпоинтам:
 *  флаги, скин-тоны и ZWJ-связки — это один видимый символ из многих кодов. */
function emojiOnly(text: string): number {
  const t = text.trim();
  if (!t || t.length > 24) return 0;
  const seg = new Intl.Segmenter('ru', { granularity: 'grapheme' });
  const clusters = [...seg.segment(t)].map((x) => x.segment);
  if (clusters.length === 0 || clusters.length > 3) return 0;
  return clusters.every((c) => /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(c))
    ? clusters.length
    : 0;
}

/** Сниппет сообщения для цитаты ответа. */
function snippetOf(m: FamilyMessage): string {
  if (m.text) return m.text.slice(0, 120);
  if (m.image) return t('Фото');
  if (m.audio) return t('Голосовое сообщение');
  if (m.file) return t('Файл');
  return t('Сообщение');
}

const SWIPE_REPLY_PX = 56; // порог свайпа вправо «ответить»
const LONG_PRESS_MS = 450;
const DOUBLE_TAP_MS = 300;

/** Пузырь сообщения с жестами «как у всех»:
 *  свайп вправо — ответить · долгое нажатие — меню · двойной тап — ❤️ ·
 *  тап по фото — просмотр · обычный тап — меню (открываемость для новичков).
 *  Вложенные кнопки (цитата, play) жестам не мешают — фильтруются по closest.
 */
function MessageRow({
  m,
  own,
  authorName,
  authorColor,
  groupStart,
  groupEnd,
  highlight,
  chips,
  maxOtherRead,
  fileReceived,
  onMenu,
  onReply,
  onHeart,
  onOpenImage,
  onDownloadFile,
  onJumpTo,
  onToggleChip,
}: {
  m: FamilyMessage;
  own: boolean;
  authorName: string | null;
  authorColor: string | null;
  /** Первый/последний в серии подряд идущих сообщений одного автора за день:
   *  имя — только на первом, «хвостик» угла — только на последнем. */
  groupStart: boolean;
  groupEnd: boolean;
  highlight: boolean;
  chips: { emoji: string; count: number; mine: boolean }[] | undefined;
  maxOtherRead: number;
  fileReceived: number;
  onMenu: (m: FamilyMessage) => void;
  onReply: (m: FamilyMessage) => void;
  onHeart: (m: FamilyMessage) => void;
  onOpenImage: (src: string) => void;
  onDownloadFile: (m: FamilyMessage) => void;
  onJumpTo: (id: string) => void;
  onToggleChip: (m: FamilyMessage, emoji: string) => void;
}) {
  const [dragX, setDragX] = useState(0);
  const g = useRef({
    x0: 0,
    y0: 0,
    // Текущий сдвиг дублируется в ref: при быстром свайпе pointerup приходит
    // до ре-рендера, и state в замыкании обработчика ещё старый.
    dx: 0,
    mode: 'idle' as 'idle' | 'swipe' | 'longpress' | 'skip',
    lastTapAt: 0,
    onImage: false,
    lpTimer: null as ReturnType<typeof setTimeout> | null,
    tapTimer: null as ReturnType<typeof setTimeout> | null,
  });

  const clearLp = () => {
    if (g.current.lpTimer) {
      clearTimeout(g.current.lpTimer);
      g.current.lpTimer = null;
    }
  };

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    // Тапы по интерактивам внутри пузыря (цитата, play) — не наши жесты.
    if ((e.target as Element).closest('button, audio')) {
      g.current.mode = 'skip';
      return;
    }
    g.current.mode = 'idle';
    g.current.x0 = e.clientX;
    g.current.y0 = e.clientY;
    g.current.onImage = Boolean((e.target as Element).closest('img'));
    clearLp();
    g.current.lpTimer = setTimeout(() => {
      // Отмечаем удержание и даём отклик, но меню открываем не здесь, а на
      // отпускании.
      //
      // Раньше меню выскакивало прямо из таймера, и палец, задержавшийся на
      // сообщении хотя бы на полсекунды, терял право на свайп: жест уже был
      // объявлен «удержанием» и движение игнорировалось. Со стороны это
      // выглядит как «свайп не работает» — человек ведёт вправо, а ответ не
      // прикрепляется. Между тем задержаться перед движением естественно:
      // сначала находишь нужное сообщение глазами, потом ведёшь.
      g.current.mode = 'longpress';
      try {
        navigator.vibrate?.(10);
      } catch {
        /* iOS игнорирует */
      }
    }, LONG_PRESS_MS);
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const s = g.current;
    if (s.mode === 'skip') return;
    const dx = e.clientX - s.x0;
    const dy = e.clientY - s.y0;
    // Палец задержался, а потом пошёл вправо — это всё-таки свайп, а не
    // удержание. Меню откроется только если отпустить не двигаясь.
    if (s.mode === 'longpress' && dx > 8 && Math.abs(dx) > Math.abs(dy)) {
      s.mode = 'idle';
    } else if (s.mode === 'longpress') {
      return;
    }
    if (s.mode === 'idle' && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
      clearLp(); // палец пошёл — это не long-press
      if (dx > 0 && Math.abs(dx) > Math.abs(dy)) {
        s.mode = 'swipe';
        e.currentTarget.setPointerCapture(e.pointerId);
      } else {
        s.mode = 'skip'; // вертикаль — отдаём скроллу ленты
      }
    }
    if (s.mode === 'swipe') {
      s.dx = Math.max(0, Math.min(SWIPE_REPLY_PX + 24, dx));
      setDragX(s.dx);
    }
  }

  function onPointerUp() {
    const s = g.current;
    clearLp();
    if (s.mode === 'swipe') {
      if (s.dx >= SWIPE_REPLY_PX) onReply(m);
      s.dx = 0;
      setDragX(0);
      s.mode = 'idle';
      return;
    }
    if (s.mode === 'longpress') {
      // Держал и отпустил, не двигая пальцем, — вот теперь меню.
      s.mode = 'idle';
      onMenu(m);
      return;
    }
    if (s.mode === 'skip') {
      s.mode = 'idle';
      return;
    }
    // Тап: различаем одиночный и двойной.
    const nowTs = Date.now();
    if (nowTs - s.lastTapAt < DOUBLE_TAP_MS) {
      s.lastTapAt = 0;
      if (s.tapTimer) {
        clearTimeout(s.tapTimer);
        s.tapTimer = null;
      }
      onHeart(m); // двойной тап — быстрое ❤️
      return;
    }
    s.lastTapAt = nowTs;
    const openImage = s.onImage && m.image;
    const isFile = Boolean(m.file); // весь пузырь файла — одна кликабельная карточка
    const msg = m;
    s.tapTimer = setTimeout(() => {
      s.tapTimer = null;
      if (openImage) onOpenImage(msg.image!);
      else if (isFile) onDownloadFile(msg);
      else onMenu(msg);
    }, DOUBLE_TAP_MS);
  }

  function onPointerCancel() {
    clearLp();
    g.current.mode = 'idle';
    g.current.dx = 0;
    setDragX(0);
  }

  // Крупные эмодзи без пузыря — только у «чистого» эмодзи-сообщения: цитата,
  // фото или файл возвращают обычный пузырь, иначе им не на чем висеть.
  const jumbo = !m.replyTo && !m.image && !m.audio && !m.file ? emojiOnly(m.text) : 0;

  return (
    <div className={`flex ${own ? 'justify-end' : 'justify-start'}`}>
      <div className={`flex max-w-[80%] flex-col ${own ? 'items-end' : 'items-start'}`}>
        <div className="flex items-center">
          {dragX > 4 && (
            <span
              className="flex shrink-0 items-center pr-2 text-accent"
              style={{ opacity: Math.min(1, dragX / SWIPE_REPLY_PX) }}
            >
              <Reply size={ICON.base} />
            </span>
          )}
          <div
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            onContextMenu={(e) => e.preventDefault()}
            style={{
              touchAction: 'pan-y',
              transform: dragX ? `translateX(${dragX}px)` : undefined,
              transition: dragX ? undefined : 'transform 160ms ease',
              WebkitTouchCallout: 'none',
            }}
            className={`cursor-pointer select-none overflow-hidden transition-shadow active:opacity-80 ${
              jumbo
                ? 'bg-transparent px-1 py-0'
                : `rounded-2xl ${m.image ? 'p-1' : 'px-3 py-2'} ${
                    own
                      ? `bg-accent-fill text-white ${groupEnd ? 'rounded-br-md' : ''}`
                      : `bg-surface-2 text-text ${groupEnd ? 'rounded-bl-md' : ''}`
                  }`
            } ${highlight ? 'ring-2 ring-frost' : ''}`}
          >
            {!own && authorName && groupStart && (
              <p className={`mb-0.5 text-xs font-semibold ${m.image ? 'px-2 pt-1' : ''}`} style={{ color: authorColor ?? undefined }}>
                {authorName}
              </p>
            )}
            {m.replyTo && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onJumpTo(m.replyTo!.id);
                }}
                className={`mb-1 block w-full rounded-lg border-l-2 px-2 py-1 text-left ${
                  m.image ? 'mx-2 mt-1 w-auto' : ''
                } ${own ? 'border-white/60 bg-white/15' : 'border-accent bg-accent/10'}`}
              >
                <span className={`block text-2xs font-semibold ${own ? 'text-white/90' : 'text-accent'}`}>
                  {m.replyTo.name}
                </span>
                <span className={`block truncate text-xs ${own ? 'text-white/75' : 'text-muted'}`}>
                  {m.replyTo.text}
                </span>
              </button>
            )}
            {m.audio && <AudioBubble src={m.audio} duration={m.audioDur ?? 0} own={own} />}
            {/* Длинное голосовое приезжает частями, как файл, — но человеку
                это знать незачем: как только запись собрана, показываем
                обычный плеер. Пока части в пути — карточка с прогрессом. */}
            {m.file &&
              (m.audioDur != null && m.fileData ? (
                <AudioBubble src={m.fileData} duration={m.audioDur} own={own} />
              ) : (
                <FileBubble m={m} own={own} received={fileReceived} />
              ))}
            {m.image && (
              <img src={m.image} alt={t('Фото')} loading="lazy" className="block max-h-80 max-w-full rounded-xl" draggable={false} />
            )}
            {m.text && jumbo > 0 && (
              <p className={`leading-none ${jumbo === 1 ? 'text-5xl' : jumbo === 2 ? 'text-4xl' : 'text-3xl'}`}>
                {m.text.trim()}
              </p>
            )}
            {m.text && jumbo === 0 && (
              // Базовый кегль приложения, а не мелкий: чат читают в том числе
              // родители, и 15px здесь были самым мелким текстом в разделе.
              <p className={`whitespace-pre-wrap break-words ${m.image ? 'px-2 pt-1' : ''}`}>
                {linkify(m.text).map((part, idx) =>
                  part.kind === 'link' ? (
                    <a
                      key={idx}
                      href={part.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      // Касание по ссылке не должно открывать меню сообщения:
                      // жесты пузыря живут на родителе.
                      onClick={(e) => e.stopPropagation()}
                      onPointerDown={(e) => e.stopPropagation()}
                      className={`underline underline-offset-2 ${own ? 'text-white' : 'text-accent'}`}
                    >
                      {part.value}
                    </a>
                  ) : (
                    <span key={idx}>{part.value}</span>
                  ),
                )}
              </p>
            )}
            <span className={`mt-0.5 flex items-center justify-end gap-1 text-2xs ${m.image ? 'px-2 pb-1' : ''} ${jumbo ? 'text-muted' : own ? 'text-white/90' : 'text-muted'}`}>
              {m.editedAt && <span>{t('изменено')}</span>}
              {timeLabel(m.createdAt)}
              {own &&
                (m.status === 'pending' ? (
                  <Clock size={ICON.inline} />
                ) : m.seq != null && maxOtherRead >= m.seq ? (
                  <CheckCheck size={ICON.inline} className="text-sky-300" />
                ) : (
                  <Check size={ICON.inline} />
                ))}
            </span>
          </div>
        </div>
        {chips && (
          <div className={`mt-1 flex flex-wrap gap-1 ${own ? 'justify-end' : ''}`}>
            {chips.map((c) => (
              <button
                key={c.emoji}
                type="button"
                onClick={() => onToggleChip(m, c.emoji)}
                className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs active:scale-95 ${
                  c.mine ? 'border-accent/50 bg-accent/15' : 'border-border bg-surface-2'
                }`}
              >
                <span>{c.emoji}</span>
                {c.count > 1 && <span className="tabular-nums text-muted">{c.count}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function ChatTab({ familyId }: { familyId: string }) {
  const toast = useToast();
  // Размер окна держим вместе с группой, к которой он относится: при переходе
  // в другую группу он вычисляется заново прямо в рендере. Сброс эффектом
  // давал бы каскад перерисовок на каждом открытии чата.
  const [win, setWin] = useState({ familyId, size: PAGE });
  const windowSize = win.familyId === familyId ? win.size : PAGE;
  const growWindow = () => setWin({ familyId, size: windowSize + PAGE });

  // Читаем ХВОСТ переписки, а не всю таблицу.
  //
  // В строках сообщений лежит их содержимое — фотографии, голосовые, куски
  // файлов, — и полное чтение поднимало из базы мегабайты на каждое входящее
  // «дзынь». Берём последние записи по составному индексу и отдельно те, что
  // ещё не ушли на сервер (у них нет порядкового номера, в диапазон они не
  // попадают, зато их всегда единицы).
  //
  // Читаем с запасом относительно показанного: в тех же строках живут реакции
  // и куски файлов, и запас держит их рядом с сообщениями, к которым они
  // относятся. Когда человек поднимается вглубь истории, окно чтения растёт
  // вместе с показанным — иначе подгрузка упёрлась бы в предел чтения.
  const readLimit = Math.max(READ_WINDOW, windowSize + PAGE * 3);
  const messagesRaw = useLiveQuery(async () => {
    const recent = await db.familyMessages
      .where('[familyId+seq]')
      .between([familyId, Dexie.minKey], [familyId, Dexie.maxKey])
      .reverse()
      .limit(readLimit)
      .toArray();
    const pending = await db.familyMessages
      .where('familyId')
      .equals(familyId)
      .filter((m) => m.seq == null)
      .toArray();
    return [...recent, ...pending];
  }, [familyId, readLimit]);
  const membersRaw = useLiveQuery(() => db.familyMembers.where('familyId').equals(familyId).toArray(), [familyId]);
  const config = useLiveQuery(() => getFamilyConfig(familyId), [familyId]);
  const selfId = config?.selfMemberId;

  // Лента открывается чаще любого другого экрана, и заглушка занимает её
  // целиком. Пока Dexie не ответил, «Пока нет сообщений» — неправда, а
  // выглядит как потерянная переписка.
  const loaded = useLoaded(messagesRaw);
  const memberMap = useMemo(() => Object.fromEntries((membersRaw ?? []).map((m) => [m.id, m])), [membersRaw]);
  const full = useMemo(() => ordered(messagesRaw ?? []), [messagesRaw]);

  // Рисуем ХВОСТ переписки, а не всю её историю.
  //
  // Замер на 1500 сообщениях (переписка семьи примерно за год): 14 000 узлов
  // в DOM, лента высотой 186 000 пикселей, прокрутка вешала вкладку на
  // десятки секунд. Открытый чат почти всегда нужен «с конца», а прошлое
  // догружается по мере подъёма — так устроены все мессенджеры.
  const list = useMemo(
    () => (full.length > windowSize ? full.slice(-windowSize) : full),
    [full, windowSize],
  );
  const hasOlder = full.length > list.length;

  // Реакции: append-only записи; последняя реакция участника на target
  // побеждает (порядок как в ленте: seq, потом pending по времени).
  const { reactionChips, myReactions } = useMemo(() => {
    const raws = (messagesRaw ?? []).filter((m) => m.reaction && !m.deletedAt).sort(msgOrder);
    const perSender = new Map<string, Map<string, string>>(); // target → sender → emoji
    for (const r of raws) {
      const { targetId, emoji } = r.reaction!;
      let m = perSender.get(targetId);
      if (!m) {
        m = new Map();
        perSender.set(targetId, m);
      }
      m.set(r.senderMemberId, emoji);
    }
    const chips = new Map<string, { emoji: string; count: number; mine: boolean }[]>();
    const mine = new Map<string, string>();
    for (const [target, senders] of perSender) {
      const agg = new Map<string, { count: number; mine: boolean }>();
      for (const [sender, emoji] of senders) {
        if (sender === selfId && emoji) mine.set(target, emoji);
        if (!emoji) continue;
        const a = agg.get(emoji) ?? { count: 0, mine: false };
        a.count += 1;
        if (sender === selfId) a.mine = true;
        agg.set(emoji, a);
      }
      if (agg.size) chips.set(target, [...agg.entries()].map(([emoji, a]) => ({ emoji, ...a })));
    }
    return { reactionChips: chips, myReactions: mine };
  }, [messagesRaw, selfId]);

  // Сколько РАЗНЫХ по idx чанков файла уже долетело до этого устройства —
  // для прогресса «Получение X из N» в карточке ещё не собранного файла.
  const fileChunkCounts = useMemo(() => {
    const byFileId = new Map<string, Set<number>>();
    for (const m of messagesRaw ?? []) {
      if (!m.fileChunk) continue;
      let idxs = byFileId.get(m.fileChunk.fileId);
      if (!idxs) {
        idxs = new Set();
        byFileId.set(m.fileChunk.fileId, idxs);
      }
      idxs.add(m.fileChunk.idx);
    }
    return byFileId;
  }, [messagesRaw]);

  // Presence в шапке чата: онлайн-статус собеседника(ов) + «был(а) в сети …».
  const others = useMemo(
    () => (membersRaw ?? []).filter((m) => !m.leftAt && m.id !== selfId),
    [membersRaw, selfId],
  );
  // Пока фото сжимается и шифруется (или файл режется на чанки), кнопка
  // занята: на большом вложении это заметная пауза, и без индикации человек
  // жмёт второй раз.
  const [sendingImage, setSendingImage] = useState(false);
  const [sendingFile, setSendingFile] = useState(false);
  const [attachSheetOpen, setAttachSheetOpen] = useState(false);
  const sendingAttachment = sendingImage || sendingFile;
  const [online, setOnline] = useState<string[]>([]);
  const [lastSeen, setLastSeen] = useState<Record<string, string>>({});
  const [now, setNow] = useState(0);
  useEffect(() => subscribePresence(familyId, setOnline), [familyId]);
  useEffect(() => subscribeLastSeen(familyId, setLastSeen), [familyId]);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const raf = requestAnimationFrame(tick); // первый расчёт сразу, вне тела эффекта (purity)
    const id = setInterval(tick, 60_000);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(id);
    };
  }, []);
  const onlineSet = useMemo(() => new Set(online), [online]);

  // «Печатает…»: memberId → момент, когда индикатор погаснет.
  const [typingUntil, setTypingUntil] = useState<Record<string, number>>({});
  useEffect(
    () =>
      subscribeTyping(familyId, (memberId) => {
        setTypingUntil((prev) => ({ ...prev, [memberId]: Date.now() + 4000 }));
      }),
    [familyId],
  );
  useEffect(() => {
    if (Object.keys(typingUntil).length === 0) return;
    const id = setInterval(() => {
      setTypingUntil((prev) => {
        const t = Date.now();
        const next = Object.fromEntries(Object.entries(prev).filter(([, until]) => until > t));
        return Object.keys(next).length === Object.keys(prev).length ? prev : next;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [typingUntil]);
  const typers = useMemo(
    () => Object.keys(typingUntil).filter((id) => id !== selfId && memberMap[id] && !memberMap[id].leftAt),
    [typingUntil, selfId, memberMap],
  );

  // Недописанное восстанавливаем сразу при первом рендере: если бы черновик
  // подставлялся эффектом, поле успело бы моргнуть пустым.
  const [text, setText] = useState(() => loadDraft(familyId)?.text ?? '');
  const [actionMsg, setActionMsg] = useState<FamilyMessage | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Цитата: пока человек её не трогал, берём сохранённую в черновике —
  // в нём лежит только идентификатор, само сообщение находится в поднятой
  // из базы переписке. Как только выбор сделан руками, он и показывается.
  const [replyPick, setReplyPick] = useState<{ familyId: string; value: FamilyMessage | null } | null>(null);
  const draftReplyId = loadDraft(familyId)?.replyToId;
  const replyTo =
    replyPick?.familyId === familyId
      ? replyPick.value
      : (draftReplyId && messagesRaw?.find((m) => m.clientMsgId === draftReplyId && !m.deletedAt)) || null;
  const setReplyTo = (value: FamilyMessage | null) => setReplyPick({ familyId, value });
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [showJump, setShowJump] = useState(false);
  const [viewImage, setViewImage] = useState<string | null>(null);
  const [reads, setReadsState] = useState<Record<string, number>>({});
  useEffect(() => subscribeReads(familyId, setReadsState), [familyId]);
  // Максимальный seq, прочитанный ХОТЬ кем-то из других участников.
  const maxOtherRead = useMemo(
    () => Object.entries(reads).reduce((mx, [id, s]) => (id !== selfId ? Math.max(mx, s) : mx), 0),
    [reads, selfId],
  );
  // До какого места было прочитано в МОМЕНТ ВХОДА. Живое значение сюда не
  // годится: открытый чат тут же отмечает всё прочитанным, и метка исчезла бы
  // раньше, чем человек успел её увидеть. Поэтому запоминаем один раз.
  const [entryMark, setEntryMark] = useState<{ familyId: string; seq: number } | null>(null);
  if (config && entryMark?.familyId !== familyId) {
    setEntryMark({ familyId, seq: config.lastReadSeq ?? 0 });
  }
  const readMark = entryMark?.familyId === familyId ? entryMark.seq : 0;

  // Сколько сообщений не поддалось расшифровке — счётчик живёт вне React
  // (его пополняет движок чата), поэтому подписываемся на него напрямую.
  const lostCount = useSyncExternalStore(
    subscribeUndecrypted,
    () => undecryptedCount(familyId),
    () => 0,
  );

  // Поиск по переписке. Ищем по базе, а не по загруженному окну: нужное почти
  // всегда старше того, что лежит в ленте.
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  useEffect(() => {
    if (!searchOpen) return;
    let cancelled = false;
    // Небольшая пауза: иначе каждая набранная буква прочёсывает историю.
    const id = setTimeout(() => {
      void searchMessages(familyId, query).then((res) => {
        if (!cancelled) setHits(res);
      });
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [familyId, query, searchOpen]);

  // Кнопка поиска — в шапке экрана: там её и ищут, и она не отнимает у
  // переписки ни пикселя высоты.
  useEffect(
    () =>
      setScreenAction({
        icon: SearchIcon,
        label: t('Искать в переписке'),
        onPress: () => setSearchOpen(true),
      }),
    [],
  );

  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const docRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Высота ленты перед доливкой прошлых сообщений. Ненулевое значение
  // одновременно служит замком: события прокрутки идут пачками, и без него
  // одно касание у верхнего края долило бы сразу несколько страниц.
  const heightBeforeGrow = useRef<number | null>(null);

  // Возврат прокрутки после доливки прошлых сообщений. Слой срабатывает,
  // когда новая разметка уже в DOM, но кадр ещё не нарисован, — человек не
  // видит скачка: сообщение, на которое он смотрел, остаётся под пальцем.
  useLayoutEffect(() => {
    const before = heightBeforeGrow.current;
    if (before === null) return;
    const el = scrollRef.current;
    if (el) el.scrollTop += el.scrollHeight - before;
    heightBeforeGrow.current = null;
  }, [windowSize]);

  // Первое сообщение, которого человек ещё не видел. Своё не считаем: метка
  // «непрочитанные» над собственной репликой выглядела бы нелепо.
  const firstUnreadId = useMemo(() => {
    if (!readMark) {
      // Ноль значит «чат ни разу не открывали»: метка над самым первым
      // сообщением ничего не сообщает — вся переписка и так новая.
      return null;
    }
    const m = list.find((x) => x.seq != null && x.seq > readMark && x.senderMemberId !== selfId);
    return m?.clientMsgId ?? null;
  }, [list, readMark, selfId]);

  // Отмечаем прочитанным до последнего seq, когда чат открыт и виден.
  //
  // Первый раз — с паузой. Во-первых, честнее: открыл и сразу ушёл — значит
  // не прочитал. Во-вторых, отметка мгновенно перезаписывала lastReadSeq в
  // базе, и запись входа (entryMark выше) успевала подхватить уже НОВОЕ
  // значение — граница непрочитанного не показывалась вовсе. Гонка редкая, но
  // на медленной базе воспроизводилась стабильно.
  const markedOnce = useRef(false);
  useEffect(() => {
    if (document.visibilityState !== 'visible') return;
    const maxSeq = list.reduce((mx, m) => Math.max(mx, m.seq ?? 0), 0);
    if (!maxSeq) return;
    if (markedOnce.current) {
      markSeen(familyId, maxSeq);
      return;
    }
    const id = setTimeout(() => {
      markedOnce.current = true;
      markSeen(familyId, maxSeq);
    }, 1200);
    return () => clearTimeout(id);
  }, [list, familyId]);

  // Автоскролл. ВАЖНО: двигаем ТОЛЬКО свой scrollRef (el.scrollTop), а не
  // scrollIntoView — тот прокручивает ВСЕХ предков, что в паре вложенных
  // overflow-контейнеров устраивало «войну скроллов» (заморозка на iOS).
  const didInitialScroll = useRef(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || list.length === 0) return;
    // Первый показ ленты. Если есть непрочитанное — встаём на границу, чтобы
    // читать с того места, где остановились, а не отлистывать назад вручную.
    // Метку ставим чуть выше верхнего края, иначе она упирается в шапку.
    if (!didInitialScroll.current) {
      didInitialScroll.current = true;
      const mark = firstUnreadId
        ? el.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(firstUnreadId)}"]`)
        : null;
      el.scrollTop = mark ? Math.max(0, mark.offsetTop - el.offsetTop - 56) : el.scrollHeight;
      return;
    }
    // Дальше — доскролл к низу при новом сообщении, только если уже у низа.
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) {
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    }
  }, [list.length, firstUnreadId]);

  // Показать сообщение, до которого человек не долистывал: находка поиска или
  // цитата на старое сообщение. Лента держит в разметке только хвост
  // переписки, поэтому сначала разворачиваем её настолько, чтобы нужное
  // попало в окно, и лишь потом прыгаем — иначе прыгать некуда.
  const pendingJump = useRef<string | null>(null);
  function revealMessage(m: FamilyMessage) {
    const idx = full.findIndex((x) => x.clientMsgId === m.clientMsgId);
    if (idx >= 0 && full.length - idx <= windowSize) {
      jumpToMessage(m.clientMsgId);
      return;
    }
    pendingJump.current = m.clientMsgId;
    // Сколько нужно показать: от найденного до конца переписки. Если
    // сообщение старше и предела чтения — берём с запасом, следующий заход
    // эффекта доберёт остальное.
    const need = idx >= 0 ? full.length - idx + 10 : windowSize + PAGE * 4;
    setWin({ familyId, size: Math.max(windowSize, need) });
  }

  // Прыжок к сообщению (тап по цитате): свой scrollTop + подсветка на секунду.
  function jumpToMessage(id: string) {
    const scrollEl = scrollRef.current;
    const node = scrollEl?.querySelector<HTMLElement>(`[data-msg-id="${id}"]`);
    if (!scrollEl || !node) return;
    const nr = node.getBoundingClientRect();
    const sr = scrollEl.getBoundingClientRect();
    scrollEl.scrollTop += nr.top - sr.top - 72;
    setHighlightId(id);
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlightId(null), 1300);
  }

  // Долистали до нужного сообщения — прыгаем. Пока его нет в разметке, ждём
  // следующего захода: окно растёт постранично. Слой стоит ПОСЛЕ объявления
  // jumpToMessage — иначе вызов идёт по подъёму объявления, а это ошибка
  // правил хуков.
  useLayoutEffect(() => {
    const id = pendingJump.current;
    if (!id) return;
    if (!scrollRef.current?.querySelector(`[data-msg-id="${CSS.escape(id)}"]`)) return;
    pendingJump.current = null;
    jumpToMessage(id);
  }, [list, windowSize]);

  // Черновик пишем сразу при вводе, а не эффектом: человек печатает и тут же
  // уходит на «Участников», и эффект не успевал отработать до размонтирования
  // — сообщение пропадало ровно в том случае, ради которого всё делалось.
  // Запись — десятки байт в localStorage, на нажатие клавиши это незаметно.
  const persistDraft = (nextText: string, nextReply: FamilyMessage | null) => {
    // Правка отправленного — не черновик нового сообщения: она живёт только
    // до ухода с экрана, и затирать ею недописанное было бы обидно.
    if (editingId) return;
    saveDraft(familyId, { text: nextText, replyToId: nextReply?.clientMsgId });
  };

  // Поле ввода растёт под текст: с фиксированной строкой длинное сообщение
  // набиралось в щёлку с внутренней прокруткой, и написанного выше не видно.
  // Потолок — в разметке (max-h), дальше поле прокручивается само.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  async function submit() {
    const body = text.trim();
    if (!body) return;
    setText('');
    clearDraft(familyId);
    if (editingId) {
      const id = editingId;
      setEditingId(null);
      await editMessage(familyId, id, body);
    } else {
      const quote = replyTo
        ? {
            id: replyTo.clientMsgId,
            // Снапшот цитаты уезжает в payload сообщения: подпись и сниппет
            // фиксируются на языке автора — как и snippetOf выше.
            name: memberMap[replyTo.senderMemberId]?.displayName || t('Участник'),
            text: snippetOf(replyTo),
          }
        : undefined;
      setReplyTo(null);
      await sendMessage(familyId, body, quote);
    }
  }

  function startEdit(m: FamilyMessage) {
    setEditingId(m.clientMsgId);
    setReplyTo(null);
    setText(m.text);
    setActionMsg(null);
  }

  function startReply(m: FamilyMessage) {
    setReplyTo(m);
    persistDraft(text, m);
    setEditingId(null);
    setActionMsg(null);
  }

  async function copyText(m: FamilyMessage) {
    setActionMsg(null);
    try {
      await navigator.clipboard.writeText(m.text);
      toast(t('Скопировано'));
    } catch {
      toast(t('Не удалось скопировать. Выделите текст вручную'));
    }
  }

  async function toggleReaction(m: FamilyMessage, emoji: string) {
    setActionMsg(null);
    const current = myReactions.get(m.clientMsgId);
    await sendReaction(familyId, m.clientMsgId, current === emoji ? '' : emoji);
  }

  async function doDelete(m: FamilyMessage) {
    setActionMsg(null);
    // Спрашиваем: удаление необратимо и стирает сообщение у всех, а меню
    // открывается одиночным касанием — промахнуться легко.
    if (!window.confirm(t('Удалить сообщение? Оно исчезнет у всех.'))) return;
    if (editingId === m.clientMsgId) {
      setEditingId(null);
      setText('');
    }
    await deleteMessage(familyId, m.clientMsgId);
  }

  /** Несколько снимков за раз: с прогулки или из поездки их всегда пачка, а
   *  выбирать по одному и ждать отправки каждого — занятие на пять минут.
   *  Отправляем последовательно: параллельная отправка перемешала бы порядок
   *  снимков в переписке, а он для фотографий важен. */
  async function handlePickImages(files: File[]) {
    for (const f of files) {
      await handlePickImage(f);
    }
  }

  async function handlePickImage(file: File) {
    // Раньше ошибка глоталась молча: человек выбирал фото, ничего не
    // происходило, и понять почему было невозможно. Молчаливый отказ хуже
    // отказа с текстом — второй хотя бы подсказывает, что делать.
    setSendingImage(true);
    try {
      const dataUrl = await compressImage(file);
      await sendImage(familyId, dataUrl);
    } catch (err) {
      if (err instanceof ImageTooLargeError) {
        toast(t('Файл больше {mb} МБ — выберите поменьше', { mb: Math.round(MAX_INPUT_BYTES / 1024 / 1024) }));
      } else if (err instanceof ImageDecodeError) {
        // Чаще всего это HEIC с айфона, открытый в стороннем браузере: формат
        // системный, и разобрать его умеет не всякий движок.
        toast(t('Не удалось открыть фото. Попробуйте другой файл'));
      } else {
        toast(t('Не удалось отправить фото. Проверьте связь'));
      }
    } finally {
      setSendingImage(false);
    }
  }

  /** Читает файл целиком в dataURL и режет на чанки — sendFile сам решает,
   *  как их отправить (см. familyChat.ts). Ограничение размера — здесь, а не
   *  внутри sendFile: сообщить человеку до траты времени на FileReader. */
  async function handlePickFile(file: File) {
    if (file.size > MAX_FILE_BYTES) {
      toast(t('Файл больше 8 МБ — такой не пройдёт через чат'));
      return;
    }
    setSendingFile(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result as string);
        fr.onerror = () => reject(new Error('read'));
        fr.readAsDataURL(file);
      });
      await sendFile(familyId, { name: file.name, mime: file.type || 'application/octet-stream', size: file.size, dataUrl });
    } catch {
      toast(t('Не удалось отправить файл. Проверьте связь'));
    } finally {
      setSendingFile(false);
    }
  }

  /** Скачивание готового файла: тап по карточке. Программный <a download> —
   *  сама карточка не может быть настоящей ссылкой без конфликта с жестами
   *  пузыря (свайп-ответ, долгое нажатие — меню). */
  function downloadFile(m: FamilyMessage) {
    if (!m.file) return;
    // Молчащий тап хуже отказа с объяснением: человек жмёт снова и снова,
    // не понимая, сломано приложение или файл.
    if (!m.fileData) {
      toast(t('Файл ещё не получен целиком — подождите пару секунд'));
      return;
    }
    const a = document.createElement('a');
    a.href = m.fileData;
    a.download = m.file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  const rec = useVoiceRecorder((dataUrl, dur) => {
    void sendAudio(familyId, dataUrl, dur);
  });

  const headerStatus = (() => {
    if (others.length === 0) return null;
    if (typers.length > 0) {
      const name = memberMap[typers[0]]?.displayName;
      return others.length === 1 ? t('печатает…') : t('{name} печатает…', { name: name || t('Кто-то') });
    }
    if (others.length === 1) {
      return onlineSet.has(others[0].id)
        ? t('в сети')
        : lastSeen[others[0].id] && now
          ? t('был(а) в сети {when}', { when: relTime(lastSeen[others[0].id], now) })
          : t('не в сети');
    }
    return t('{n} в сети', { n: others.filter((o) => onlineSet.has(o.id)).length });
  })();

  return (
    // Полная высота под чат от каркаса (Screen fill): лента растёт и скроллится,
    // композер прибит к низу. Без magic-number — высоту даёт родитель.
    <div className="flex h-full min-h-0 flex-col">
      {/* Для группы из нескольких собеседников строка «0 в сети» не сообщает
          ничего, чего человек уже не предполагает, — прячем её, пока никто не
          появился и не печатает. Для одного собеседника показываем всегда:
          «был(а) в сети 2 ч назад» — это ценность, а не шум. Кнопка поиска
          живёт в шапке экрана: отдельная строка ради неё стоила бы переписке
          два десятка пикселей на каждом экране. */}
      {!searchOpen &&
        others.length > 0 &&
        (others.length === 1 || typers.length > 0 || others.some((o) => onlineSet.has(o.id))) && (
        <div className="flex shrink-0 items-center gap-1.5 px-1 pb-1.5 text-xs">
          {others.length === 1 ? (
            <>
              <span
                className={`size-2 shrink-0 rounded-full ${onlineSet.has(others[0].id) ? 'bg-success' : 'bg-muted'}`}
              />
              <span className="font-medium" style={{ color: others[0].color }}>
                {others[0].displayName}
              </span>
              <span className={typers.length > 0 ? 'text-accent' : 'text-muted'}>{headerStatus}</span>
            </>
          ) : (
            <>
              <span
                className={`size-2 shrink-0 rounded-full ${
                  others.some((o) => onlineSet.has(o.id)) ? 'bg-success' : 'bg-muted'
                }`}
              />
              <span className={typers.length > 0 ? 'text-accent' : 'text-muted'}>{headerStatus}</span>
            </>
          )}
        </div>
      )}
      {searchOpen && (
        <div className="mb-2 shrink-0">
          <div className="flex items-center gap-2 rounded-2xl border border-border bg-surface px-3 py-1.5 focus-within:border-accent">
            <SearchIcon size={ICON.action} className="shrink-0 text-muted" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('Искать в переписке')}
              // 16px, иначе Safari при фокусе увеличивает страницу.
              className="min-w-0 flex-1 bg-transparent py-1.5 text-base outline-none"
            />
            <button
              onClick={() => {
                setSearchOpen(false);
                setQuery('');
                setHits([]);
              }}
              aria-label={t('Закрыть поиск')}
              className={`shrink-0 p-1 text-muted active:opacity-60 ${HIT_SLOP_44}`}
            >
              <X size={ICON.action} />
            </button>
          </div>
          {query.trim().length >= 2 && (
            // Плотный фон и тень: полупрозрачная подложка сливалась с лентой,
            // и находки читались как продолжение переписки.
            <div className="mt-1.5 max-h-56 overflow-y-auto rounded-2xl border border-border bg-surface shadow-lg">
              {hits.length === 0 ? (
                <p className="px-3 py-2.5 text-xs text-muted">{t('Ничего не нашлось')}</p>
              ) : (
                hits.map((h) => (
                  <button
                    key={h.message.clientMsgId}
                    onClick={() => {
                      setSearchOpen(false);
                      revealMessage(h.message);
                    }}
                    className="flex w-full items-baseline gap-2 border-b border-hairline/50 px-3 py-2 text-left last:border-0 active:bg-surface-2"
                  >
                    <span className="min-w-0 flex-1 truncate text-xs">
                      <span className="font-medium" style={{ color: memberMap[h.message.senderMemberId]?.color }}>
                        {memberMap[h.message.senderMemberId]?.displayName || t('Участник')}
                      </span>
                      {': '}
                      {/* Найденное выделяем: в длинной строке иначе не видно,
                          за что она зацепилась. */}
                      {h.message.text.slice(Math.max(0, h.from - 24), h.from)}
                      <mark className="rounded bg-accent/25 text-text">{h.message.text.slice(h.from, h.to)}</mark>
                      {h.message.text.slice(h.to, h.to + 40)}
                    </span>
                    <span className="shrink-0 text-2xs text-muted">
                      {now ? dayLabel(h.message.createdAt, now) : ''}
                    </span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      )}
      {lostCount > 0 && (
        // Тонкая строка, а не карточка: потеря редкая, но знать о ней человек
        // должен. Крестик убирает счётчик — сообщения от этого не вернутся,
        // но и висеть вечно предупреждению незачем.
        <div className="mb-2 flex shrink-0 items-center gap-2 rounded-xl bg-warning/10 px-3 py-2 text-xs leading-snug text-warning">
          <span className="min-w-0 flex-1">
            {t('Не удалось прочитать сообщений: {n}. Они зашифрованы ключом, которого нет на этом устройстве.', {
              n: lostCount,
            })}
          </span>
          <button
            onClick={() => clearUndecrypted(familyId)}
            aria-label={t('Скрыть')}
            className={`shrink-0 p-1 opacity-70 active:opacity-40 ${HIT_SLOP_44}`}
          >
            <X size={ICON.action} />
          </button>
        </div>
      )}
      {/* overscroll-contain: флик до края ленты НЕ чейнится в App-контейнер —
          без этого на iOS-momentum «война скроллов» с предком насыщала
          main-thread и чат замирал после прокруток вверх-вниз. */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            setShowJump(el.scrollHeight - el.scrollTop - el.clientHeight > 320);
            // Дошли до верха окна — доливаем предыдущую страницу переписки.
            // Высоту запоминаем ДО дорисовки: восстановлением позиции займётся
            // слой ниже, уже после того как новые сообщения окажутся в разметке.
            if (hasOlder && el.scrollTop < 240 && heightBeforeGrow.current === null) {
              heightBeforeGrow.current = el.scrollHeight;
              growWindow();
            }
          }}
          className="h-full overflow-y-auto overscroll-contain px-1"
        >
          {list.length === 0 ? (
            loaded && (
              <p className="py-12 text-center text-sm text-muted">{t('Пока нет сообщений. Напишите первым!')}</p>
            )
          ) : (
            // justify-end: короткая переписка живёт у композера, как во всех
            // мессенджерах, а не болтается в середине экрана. Ритм отступов —
            // по сериям (см. sameGroup), а не одинаковой прокладкой.
            <div className="flex min-h-full flex-col justify-end py-2">
              {/* Явный признак, что переписка длиннее показанного: без него
                  подгрузка на подъёме выглядит как случайность. */}
              {hasOlder && (
                <div className="flex items-center justify-center py-2">
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2/70 px-3 py-1 text-2xs text-muted">
                    <LoaderCircle size={ICON.inline} className="animate-spin" />
                    {t('Загружаю прошлые сообщения…')}
                  </span>
                </div>
              )}
              {list.map((m, i) => {
                const sameGroup = (a: FamilyMessage | undefined, b: FamilyMessage) =>
                  Boolean(
                    a &&
                      !a.system &&
                      !b.system &&
                      a.senderMemberId === b.senderMemberId &&
                      dayKey(a.createdAt) === dayKey(b.createdAt),
                  );
                const groupStart = !sameGroup(list[i - 1], m);
                const groupEnd = !sameGroup(list[i + 1] as FamilyMessage | undefined, m);
                const divider =
                  i === 0 || dayKey(list[i - 1].createdAt) !== dayKey(m.createdAt) ? (
                    <div key={`d-${m.clientMsgId}`} className="flex items-center justify-center py-1.5">
                      <span className="rounded-full bg-surface-2/80 px-3 py-0.5 text-2xs font-medium text-muted">
                        {now ? dayLabel(m.createdAt, now) : ''}
                      </span>
                    </div>
                  ) : null;
                // Граница прочитанного: всё, что ниже, пришло после прошлого
                // захода. Линия с подписью — как в почте и мессенджерах.
                const unreadMark =
                  m.clientMsgId === firstUnreadId ? (
                    <div key={`u-${m.clientMsgId}`} className="flex items-center gap-2 py-2">
                      <span className="h-px flex-1 bg-accent/30" />
                      <span className="rounded-full bg-accent/12 px-2.5 py-0.5 text-2xs font-semibold text-accent">
                        {t('Непрочитанные')}
                      </span>
                      <span className="h-px flex-1 bg-accent/30" />
                    </div>
                  ) : null;
                if (m.system) {
                  return (
                    <div key={m.clientMsgId} className="mt-2">
                      {divider}
                      {unreadMark}
                      {/* Полупрозрачная плашка: служебные события не должны
                          весить столько же, сколько живые сообщения. */}
                      <div className="py-0.5 text-center">
                        <span className="inline-block rounded-full bg-surface-2/70 px-3 py-1 text-xs text-muted">{systemMessageText(m)}</span>
                      </div>
                    </div>
                  );
                }
                const own = m.senderMemberId === selfId;
                const author = memberMap[m.senderMemberId];
                const chips = reactionChips.get(m.clientMsgId);
                return (
                  <div key={m.clientMsgId} className={groupStart ? 'mt-2.5' : 'mt-0.5'}>
                    {divider}
                    {unreadMark}
                    <div data-msg-id={m.clientMsgId}>
                      <MessageRow
                        m={m}
                        own={own}
                        authorName={author?.displayName ?? null}
                        authorColor={author?.color ?? null}
                        groupStart={groupStart}
                        groupEnd={groupEnd}
                        highlight={highlightId === m.clientMsgId}
                        chips={chips}
                        maxOtherRead={maxOtherRead}
                        fileReceived={m.file ? (fileChunkCounts.get(m.file.fileId)?.size ?? 0) : 0}
                        onMenu={setActionMsg}
                        onReply={startReply}
                        onHeart={(msg) => void toggleReaction(msg, '❤️')}
                        onOpenImage={setViewImage}
                        onDownloadFile={downloadFile}
                        onJumpTo={jumpToMessage}
                        onToggleChip={(msg, emoji) => void toggleReaction(msg, emoji)}
                      />
                    </div>
                  </div>
                );
              })}
              {/* Подсказка внутри ленты, а не над ней: стоя отдельной плашкой,
                  она занимала половину экрана телефона, и переписки в первый
                  день пользования было почти не видно. Здесь она попадается
                  на глаза при открытии и уезжает при первой же прокрутке. */}
              <Hint
                id="chat-gestures"
                title={t('Жесты чата')}
                className="mt-3"
                items={
                  isTouch
                    ? [
                        { icon: ArrowRight, text: <>{t('Проведите по сообщению вправо — ответить')}</> },
                        { icon: Heart, text: <>{t('Двойное касание — быстрое ❤️')}</> },
                        { icon: Hand, text: <>{t('Касание или удержание — меню: реакции, копировать, править')}</> },
                      ]
                    : [
                        { icon: ArrowRight, text: <>{t('Потяните сообщение мышью вправо — ответить')}</> },
                        { icon: Heart, text: <>{t('Двойной клик — быстрое ❤️')}</> },
                        { icon: Hand, text: <>{t('Клик — меню: реакции, копировать, править')}</> },
                      ]
                }
              />
              <div ref={bottomRef} />
            </div>
          )}
        </div>
        {showJump && (
          <button
            type="button"
            aria-label={t('К последним сообщениям')}
            onClick={() => {
              const el = scrollRef.current;
              if (el) el.scrollTop = el.scrollHeight;
            }}
            className="absolute bottom-3 right-2 flex size-10 items-center justify-center rounded-full border border-border bg-elevated/95 text-muted shadow-lg shadow-black/20 active:scale-95"
          >
            <ChevronsDown size={ICON.header} />
          </button>
        )}
      </div>

      <div className="shrink-0 border-t border-hairline bg-bg">
        {editingId && (
          <div className="flex items-center gap-2 px-1 pt-2 text-sm text-muted">
            <Pencil size={ICON.inline} className="shrink-0 text-accent" />
            <span className="flex-1">{t('Редактирование сообщения')}</span>
            <button
              onClick={() => {
                setEditingId(null);
                setText('');
              }}
              aria-label={t('Отменить редактирование')}
              className={`p-1 active:opacity-60 ${HIT_SLOP_44}`}
            >
              <X size={ICON.action} />
            </button>
          </div>
        )}
        {replyTo && (
          <div className="flex items-center gap-2 px-1 pt-2 text-sm">
            <Reply size={ICON.inline} className="shrink-0 text-accent" />
            <div className="min-w-0 flex-1 border-l-2 border-accent pl-2">
              <p className="text-xs font-semibold text-accent">
                {memberMap[replyTo.senderMemberId]?.displayName || t('Участник')}
              </p>
              <p className="truncate text-xs text-muted">{snippetOf(replyTo)}</p>
            </div>
            <button
              onClick={() => {
                setReplyTo(null);
                persistDraft(text, null);
              }}
              aria-label={t('Отменить ответ')}
              className={`p-1 text-muted active:opacity-60 ${HIT_SLOP_44}`}
            >
              <X size={ICON.action} />
            </button>
          </div>
        )}
        {rec.recording ? (
          <div className="flex items-center gap-3 px-2 py-2">
            <button
              onClick={rec.cancel}
              aria-label={t('Отменить запись')}
              className="flex size-11 shrink-0 items-center justify-center rounded-full bg-danger/15 text-danger active:scale-95"
            >
              <Trash2 size={ICON.header} />
            </button>
            <div className="flex flex-1 items-center gap-2 text-sm">
              <span className="size-2.5 shrink-0 animate-pulse rounded-full bg-danger" />
              <span className="font-mono tabular-nums">{fmtDur(rec.elapsed)}</span>
              <span className="text-muted">{t('запись…')}</span>
            </div>
            <button
              onClick={rec.stop}
              aria-label={t('Отправить голосовое')}
              className="flex size-11 shrink-0 items-center justify-center rounded-full bg-accent-fill text-white active:scale-95"
            >
              <Send size={ICON.header} />
            </button>
          </div>
        ) : (
          // Одна цельная капсула во всю ширину экрана: скрепка внутри слева,
          // отправка/микрофон внутри справа, до краёв — по 6px, только чтобы
          // скругление не резалось об рамку экрана. Никаких отдельно висящих
          // кнопок и широких полей — просьба Влада «на всю длину» буквально.
          <div className="px-1.5 py-2">
            <input
              ref={imageRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = '';
                if (files.length) void handlePickImages(files);
              }}
            />
            <input
              ref={docRef}
              type="file"
              accept="*/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void handlePickFile(f);
              }}
            />
            <div className="flex w-full items-end rounded-3xl border border-border bg-surface transition-[border-color,box-shadow] focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20">
              <button
                onClick={() => setAttachSheetOpen(true)}
                disabled={sendingAttachment}
                aria-label={sendingAttachment ? t('Вложение отправляется') : t('Прикрепить')}
                aria-busy={sendingAttachment || undefined}
                className="flex size-11 shrink-0 select-none items-center justify-center self-end rounded-full text-muted active:text-accent disabled:opacity-50"
              >
                {sendingAttachment ? (
                  <LoaderCircle size={ICON.header} className="animate-spin motion-reduce:animate-none" />
                ) : (
                  <Paperclip size={ICON.header} />
                )}
              </button>
              <textarea
                ref={inputRef}
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  persistDraft(e.target.value, replyTo);
                  if (e.target.value.trim()) sendTyping(familyId);
                }}
                onKeyDown={(e) => {
                  // На тач-устройствах Enter = перенос строки (отправка — кнопкой):
                  // экранная клавиатура ставит «ввод», а не «отправить».
                  if (e.key === 'Enter' && !e.shiftKey && !isTouch) {
                    e.preventDefault();
                    void submit();
                  }
                }}
                rows={1}
                placeholder={t('Сообщение…')}
                // Шрифт не меньше 16px: на iOS поле с мелким шрифтом заставляет
                // Safari при фокусе увеличить всю страницу, и после набора она
                // остаётся увеличенной — чат «уезжает» за край экрана.
                className="max-h-40 min-h-[44px] min-w-0 flex-1 resize-none bg-transparent py-2.5 pl-0.5 pr-2 text-base leading-snug outline-none"
              />
              {text.trim() || !rec.supported ? (
                <button
                  onClick={() => void submit()}
                  disabled={!text.trim()}
                  aria-label={t('Отправить')}
                  className={`m-1 flex size-9 shrink-0 select-none items-center justify-center self-end rounded-full bg-accent-fill text-white disabled:opacity-40 active:scale-95 ${HIT_SLOP_44}`}
                >
                  <Send size={ICON.base} />
                </button>
              ) : (
                <button
                  onClick={() => {
                    // start() возвращает false, если разрешения нет или запись
                    // не поддерживается. Раньше это терялось, и кнопка
                    // выглядела сломанной.
                    void rec.start().then((ok) => {
                      if (!ok) toast(t('Нет доступа к микрофону'));
                    });
                  }}
                  aria-label={t('Записать голосовое')}
                  className={`m-1 flex size-9 shrink-0 select-none items-center justify-center self-end rounded-full bg-accent-fill text-white active:scale-95 ${HIT_SLOP_44}`}
                >
                  <Mic size={ICON.base} />
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <Sheet open={attachSheetOpen} onClose={() => setAttachSheetOpen(false)} title={t('Вложение')}>
        <div className="space-y-2 pb-2">
          <button
            onClick={() => {
              setAttachSheetOpen(false);
              imageRef.current?.click();
            }}
            className="flex w-full items-center gap-3 rounded-xl bg-surface-2 p-3.5 text-left active:opacity-80"
          >
            <ImageIcon size={ICON.base} className="text-accent" />
            {t('Фото')}
          </button>
          <button
            onClick={() => {
              setAttachSheetOpen(false);
              docRef.current?.click();
            }}
            className="flex w-full items-center gap-3 rounded-xl bg-surface-2 p-3.5 text-left active:opacity-80"
          >
            <FileIcon size={ICON.base} className="text-accent" />
            {t('Файл')}
          </button>
        </div>
      </Sheet>

      <Sheet open={actionMsg !== null} onClose={() => setActionMsg(null)} title={t('Сообщение')}>
        {actionMsg && (
          <div className="space-y-2 pb-2">
            {!actionMsg.system && (
              <div className="flex justify-between gap-1 rounded-2xl bg-surface-2 p-2">
                {REACTIONS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => void toggleReaction(actionMsg, emoji)}
                    aria-label={t('Реакция {emoji}', { emoji })}
                    className={`flex size-10 items-center justify-center rounded-full text-lg transition-transform active:scale-90 ${
                      myReactions.get(actionMsg.clientMsgId) === emoji ? 'bg-accent/20 ring-1 ring-accent/50' : ''
                    }`}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
            <button
              onClick={() => startReply(actionMsg)}
              className="flex w-full items-center gap-3 rounded-xl bg-surface-2 p-3.5 text-left active:opacity-80"
            >
              <Reply size={ICON.base} className="text-accent" />
              {t('Ответить')}
            </button>
            {actionMsg.text && (
              <button
                onClick={() => void copyText(actionMsg)}
                className="flex w-full items-center gap-3 rounded-xl bg-surface-2 p-3.5 text-left active:opacity-80"
              >
                <Copy size={ICON.base} className="text-accent" />
                {t('Копировать')}
              </button>
            )}
            {actionMsg.senderMemberId === selfId && !actionMsg.image && !actionMsg.audio && !actionMsg.file && (
              <button
                onClick={() => startEdit(actionMsg)}
                className="flex w-full items-center gap-3 rounded-xl bg-surface-2 p-3.5 text-left active:opacity-80"
              >
                <Pencil size={ICON.base} className="text-accent" />
                {t('Редактировать')}
              </button>
            )}
            {actionMsg.senderMemberId === selfId && (
              <button
                onClick={() => void doDelete(actionMsg)}
                className="flex w-full items-center gap-3 rounded-xl bg-danger/15 p-3.5 text-left text-danger active:opacity-80"
              >
                <Trash2 size={ICON.base} />
                {t('Удалить')}
              </button>
            )}
          </div>
        )}
      </Sheet>

      {/* Фото на весь экран (тап по фото в ленте) — закрытие тапом. */}
      {viewImage && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/95 p-3"
          onClick={() => setViewImage(null)}
        >
          <img src={viewImage} alt="" className="max-h-full max-w-full rounded-xl object-contain" />
        </div>
      )}
    </div>
  );
}
