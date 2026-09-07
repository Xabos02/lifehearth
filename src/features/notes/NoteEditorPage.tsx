import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { format } from 'date-fns';
import { dateLocale } from '../../lib/dates';
import { getLang, t } from '../../lib/i18n';
import { marked } from 'marked';
import { Pin, SlidersHorizontal, Type } from 'lucide-react';
import {
  GAttach,
  GBold,
  GBullets as List,
  GChecklist as ListChecks,
  GItalic,
  GNumbers as ListOrdered,
  GStrike,
  GTrash as Trash2,
  GUndo as Undo2,
} from '../../components/ui/glyphs';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { Screen } from '../../components/layout/Screen';
import { useKeyboardInset } from '../../hooks/useKeyboardInset';
import { MicButton } from '../../components/ui/MicButton';
import { Hint } from '../../components/ui/Hint';
import { db } from '../../db/db';
import {
  caretAtLineStart,
  caretLineHasText,
  caretOffset,
  normalizeEditor,
  setCaretAtOffset,
} from './editorDom';
import { isRefused, shouldCapitalize, type CapitalizeMemo } from './autocapitalize';
import { closestChecklistItem, hitCheckbox, toggleChecklist, toggleItem } from './checklist';
import { sanitizeNoteHtml } from './sanitize';
import { NoteAttachments } from './NoteAttachments';
import { MAX_FILE_BYTES, formatFileSize, groupNoteAttachments, planNoteFileChunks } from '../../lib/noteFiles';
import { ImageTooLargeError, MAX_INPUT_BYTES, compressImage } from '../../lib/image';
import { useToast } from '../../components/ui/toastContext';
import { create, remove, uid, update } from '../../db/repo';
import { ICON, STROKE_STRONG } from '../../components/ui/icons';
import { IconButton } from '../../components/ui/IconButton';

const AUTOSAVE_MS = 600;

/** Команды, которые пересобирают блок вокруг каретки, а не красят выделение. */
const BLOCK_COMMANDS = new Set(['insertUnorderedList', 'insertOrderedList', 'formatBlock']);

/** Заголовок заметки = первая непустая строка её текста (как в iOS).
 *  Без жёсткого лимита: режем лишь на 300 символов — защита от «заголовка» в
 *  абзац, но обычные длинные названия сохраняются целиком. */
function deriveTitle(text: string): string {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t) return t.slice(0, 300);
  }
  return '';
}

function ToolBtn({
  onClick,
  label,
  active,
  bare,
  className = '',
  children,
}: {
  onClick: () => void;
  label: string;
  /** Подсветка «формат включён». У кнопок-действий (отмена) состояния нет. */
  active?: boolean;
  /** Кнопка полосы: без собственной подложки — полоса спокойная, подложка
   *  появляется только у активного состояния (как в Apple Notes). */
  bare?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      // не отдаём фокус из редактора — иначе пропадёт выделение
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`flex size-11 items-center justify-center rounded-xl transition-colors ${
        active
          ? 'bg-accent/15 text-accent'
          : bare
            ? 'text-text active:bg-surface-2'
            : 'bg-surface-2 text-text active:bg-elevated'
      } ${className}`}
    >
      {children}
    </button>
  );
}

export function NoteEditorPage() {
  const { id: routeId } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  // Папка, в которой нажали «+». В ref, а не в state: значение нужно внутри
  // flush, который вызывается по таймеру и из обработчика ухода со страницы —
  // там актуальность важнее реактивности.
  const folderRef = useRef<string | null>(searchParams.get('folder'));
  const navigate = useNavigate();
  const isNew = routeId === 'new';

  const editorRef = useRef<HTMLDivElement>(null);
  const savedIdRef = useRef<string | null>(null);
  /** Штамп версии, которую редактор сейчас показывает (своей или пришедшей).
   *  По нему отличаем правку с ДРУГОГО устройства от собственного
   *  автосохранения — иначе каждое своё сохранение выглядело бы как чужое. */
  const knownAtRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const deletedRef = useRef(false);
  const initializedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pinnedRef = useRef(false);
  const savingRef = useRef(false);
  // Последняя автозаглавная — чтобы человек мог её отменить (см. autocapitalize.ts).
  const capMemo = useRef<CapitalizeMemo | null>(null);

  const [pinned, setPinned] = useState(false);
  const [saved, setSaved] = useState(false);
  // Дата изменения под шапкой — как в Apple Notes. null, пока существующая
  // заметка не загрузилась: мигать сегодняшней датой на чужой заметке нельзя.
  const [editedAt, setEditedAt] = useState<string | null>(isNew ? new Date().toISOString() : null);
  // Активность кнопок форматирования для подсветки в тулбаре.
  const [active, setActive] = useState({
    bold: false, italic: false, ul: false, ol: false,
    strike: false, h2: false, quote: false, checklist: false,
  });
  // Панель «Aa»: стили текста спрятаны за одной кнопкой, как в Apple Notes, —
  // полоса остаётся из пяти понятных входов без горизонтального скролла.
  const [formatOpen, setFormatOpen] = useState(false);

  // Пересчитываем активные форматы по текущему выделению (в обработчике, не в
  // рендере). Тротл: selectionchange стреляет на каждый символ, а 4 вызова
  // queryCommandState на iOS дороги — на длинной заметке подвешивали ввод.
  const activeThrottle = useRef(0);
  const syncActive = useCallback(() => {
    const now = Date.now();
    if (now - activeThrottle.current < 200) return;
    activeThrottle.current = now;
    const el = editorRef.current;
    const sel = document.getSelection();
    if (!el || !sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) return;
    // Блочные форматы queryCommandState не отдаёт — смотрим по DOM вокруг
    // каретки. queryCommandValue('formatBlock') на Safari возвращает пустую
    // строку внутри списков, поэтому на него полагаться нельзя.
    const anchor = sel.anchorNode;
    const host = anchor instanceof Element ? anchor : anchor?.parentElement;
    setActive({
      bold: document.queryCommandState('bold'),
      italic: document.queryCommandState('italic'),
      ul: document.queryCommandState('insertUnorderedList'),
      ol: document.queryCommandState('insertOrderedList'),
      strike: document.queryCommandState('strikeThrough'),
      h2: Boolean(host?.closest('h2')),
      quote: Boolean(host?.closest('blockquote')),
      checklist: Boolean(closestChecklistItem(anchor)),
    });
  }, []);

  // Подсветка следует за курсором/выделением, пока редактор открыт.
  useEffect(() => {
    document.addEventListener('selectionchange', syncActive);
    return () => document.removeEventListener('selectionchange', syncActive);
  }, [syncActive]);

  // Заглавная буква в начале строки и пункта списка. Вешаем НАТИВНЫЙ
  // beforeinput: у React-обёртки над этим событием нет inputType, без которого
  // не отличить набор с клавиатуры от вставки, автозамены или диктовки —
  // поднимать регистр надо только в первом случае.
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const onBeforeInput = (e: Event) => {
      const ev = e as InputEvent;
      // Человек стёр символ — возможно, ровно нашу подстановку. Помечаем и
      // ждём: если следом придёт та же буква в то же место, значит он с нами
      // не согласен и настаивает на строчной.
      if (ev.inputType.startsWith('deleteContent')) {
        if (capMemo.current) capMemo.current.undone = true;
        return;
      }
      if (ev.inputType !== 'insertText') return;
      const here = caretOffset(el) ?? -1;
      if (isRefused(capMemo.current, ev.data ?? '', here)) {
        capMemo.current = null; // уважили отказ — дальше эта позиция обычная
        return;
      }
      if (!shouldCapitalize(el, document.getSelection(), ev.data)) return;
      ev.preventDefault();
      // execCommand, а не ручная правка DOM: он сам двигает каретку и, главное,
      // пишется в стек отмены — иначе «отменить» перепрыгивало бы через букву.
      document.execCommand('insertText', false, ev.data!.toUpperCase());
      capMemo.current = { char: ev.data!, offset: caretOffset(el) ?? -1, undone: false };
    };
    el.addEventListener('beforeinput', onBeforeInput);
    return () => el.removeEventListener('beforeinput', onBeforeInput);
  }, []);

  useEffect(() => {
    pinnedRef.current = pinned;
  }, [pinned]);

  // Одноразовая загрузка в редактор: live-binding вреден — автосейв перетёр бы
  // поле под руками. Удалённую по URL заметку трактуем как ненайденную.
  useEffect(() => {
    if (isNew) {
      editorRef.current?.focus();
      return;
    }
    if (!routeId || initializedRef.current || savedIdRef.current) return;
    let cancelled = false;
    void db.notes.get(routeId).then((n) => {
      if (cancelled || !n || n.deletedAt || initializedRef.current) return;
      initializedRef.current = true;
      savedIdRef.current = n.id;
      knownAtRef.current = n.updatedAt;
      setPinned(n.pinned);
      setEditedAt(n.updatedAt);
      if (editorRef.current) {
        const raw = n.content || '';
        // Заметки v1 хранили markdown, новый редактор работает с HTML. Старый
        // контент (без HTML-тегов) конвертируем в HTML и помечаем dirty — он
        // один раз пересохранится в новом формате, а не сломается при правке.
        const looksHtml = /<\/?[a-z][^>]*>/i.test(raw);
        if (looksHtml || !raw) {
          editorRef.current.innerHTML = raw;
        } else {
          editorRef.current.innerHTML = sanitizeNoteHtml(marked.parse(raw, { async: false }) as string);
          dirtyRef.current = true;
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [routeId, isNew]);

  const toast = useToast();

  // Правка, пришедшая с другого устройства.
  //
  // Содержимое грузится в редактор ОДИН раз (см. эффект выше): живая привязка
  // перетирала бы текст под руками при автосохранении. Обратная сторона —
  // приехавшая правка не показывалась вовсе, пока экран открыт: владелец
  // добавлял фото в заметку на телефоне, а на маке его не было до перезапуска
  // приложения.
  //
  // Компромисс по цене ошибки: подхватываем молча только когда перетирать
  // нечего — нет несохранённых правок и курсор не в тексте. Иначе просто
  // говорим, что версия разошлась: чужой текст поверх набираемого не кладём
  // ни при каких условиях.
  const [remoteChanged, setRemoteChanged] = useState(false);
  const liveNote = useLiveQuery(
    () => (isNew || !routeId ? undefined : db.notes.get(routeId)),
    [routeId, isNew],
  );
  useEffect(() => {
    if (!liveNote || liveNote.deletedAt || !initializedRef.current) return;
    if (!liveNote.updatedAt || liveNote.updatedAt === knownAtRef.current) return;
    const el = editorRef.current;
    if (!el) return;
    const typing = dirtyRef.current || document.activeElement === el;
    if (typing) {
      setRemoteChanged(true);
      return;
    }
    el.innerHTML = liveNote.content || '';
    knownAtRef.current = liveNote.updatedAt;
    setEditedAt(liveNote.updatedAt);
    setPinned(liveNote.pinned);
    setRemoteChanged(false);
  }, [liveNote, isNew]);

  const flush = useCallback(async () => {
    const el = editorRef.current;
    if (deletedRef.current || !dirtyRef.current || !el || savingRef.current) return;
    savingRef.current = true; // in-flight guard: не создаём дубль новой заметки
    try {
      const html = sanitizeNoteHtml(el.innerHTML);
      const plain = (el.innerText ?? '').trim();
      // Заметка из одной фотографии: innerText пуст, но содержимое есть —
      // и сохранить её надо, и в списке ей нужен хоть какой-то заголовок.
      const hasImage = Boolean(el.querySelector('img'));
      const title = deriveTitle(el.innerText ?? '') || (hasImage ? t('Фото') : '');
      if (savedIdRef.current) {
        await update(db.notes, savedIdRef.current, {
          title,
          content: html,
          pinned: pinnedRef.current,
        });
        // Свою же запись не должны принять за чужую: запоминаем её штамп.
        knownAtRef.current = (await db.notes.get(savedIdRef.current))?.updatedAt ?? null;
      } else if (plain || hasImage) {
        // Пустую новую заметку не сохраняем (как в iOS).
        const created = await create(db.notes, {
          title,
          content: html,
          tags: [],
          pinned: pinnedRef.current,
          folderId: folderRef.current,
        });
        savedIdRef.current = created.id;
        knownAtRef.current = created.updatedAt;
        navigate(`/notes/${created.id}`, { replace: true });
      }
      // Флаг «есть несохранённое» снимаем ТОЛЬКО после успешной записи.
      // Раньше он снимался до неё, и упавшее сохранение уже не повторялось:
      // текст оставался на экране, но в базу не попадал никогда, а человеку
      // об этом не говорили. Заметку теряла первая же нехватка места.
      dirtyRef.current = false;
      setSaved(true);
    } catch {
      // Не молчим: на экране текст цел, и человек должен знать, что его надо
      // сохранить ещё раз (или освободить место), а не закрывать заметку.
      toast(t('Не удалось сохранить заметку. Текст на экране цел — попробуйте ещё раз'));
    } finally {
      savingRef.current = false;
    }
  }, [navigate, toast]);

  const touch = useCallback(() => {
    dirtyRef.current = true;
    setSaved(false);
    setEditedAt(new Date().toISOString());
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void flush(), AUTOSAVE_MS);
  }, [flush]);

  const toolbarRef = useRef<HTMLDivElement>(null);
  const keyboardInset = useKeyboardInset();

  // === Фото и файлы ===

  const fileInputRef = useRef<HTMLInputElement>(null);
  // Куда смотрела каретка в момент нажатия кнопки: системный пикер уводит
  // фокус, и к возвращению выбранного файла выделение уже потеряно.
  const caretBeforePickRef = useRef<number | null>(null);

  // id заметки для живого запроса вложений. routeId, а не savedIdRef: ref не
  // реактивен, а после первого сохранения новая заметка получает настоящий
  // адрес через navigate(replace) — и запрос оживает сам.
  const noteId = isNew ? null : (routeId ?? null);
  const attachments = useLiveQuery(
    async () => {
      if (!noteId) return [];
      return groupNoteAttachments(await db.noteFiles.where('noteId').equals(noteId).toArray());
    },
    [noteId],
    [],
  );

  /** id заметки, создав запись при необходимости: вложению нужен носитель.
   *  Сначала обычный flush (он же создаст заметку с текстом), а пустую под
   *  вложение создаём отдельно — flush пустых не пишет, и это правильно для
   *  текста, но файл сам по себе уже содержимое. */
  const ensureNote = useCallback(async (): Promise<string | null> => {
    if (!savedIdRef.current) {
      dirtyRef.current = true;
      await flush();
    }
    if (!savedIdRef.current) {
      const created = await create(db.notes, {
        title: '',
        content: '',
        tags: [],
        pinned: pinnedRef.current,
        folderId: folderRef.current,
      });
      savedIdRef.current = created.id;
      navigate(`/notes/${created.id}`, { replace: true });
    }
    return savedIdRef.current;
  }, [flush, navigate]);

  /** Фото — инлайн в текст, в позицию каретки (как в Apple Notes). Сжатие то
   *  же, что в чате и «Местах»: длинная сторона 1024, JPEG 0.6. */
  const addPhoto = useCallback(
    async (file: File) => {
      const el = editorRef.current;
      if (!el) return;
      let dataUrl: string;
      try {
        dataUrl = await compressImage(file);
      } catch (err) {
        toast(
          err instanceof ImageTooLargeError
            ? t('Фото больше {mb} МБ — выберите поменьше', {
                mb: Math.round(MAX_INPUT_BYTES / 1024 / 1024),
              })
            : t('Не удалось открыть фото. Попробуйте другой файл'),
        );
        return;
      }
      el.focus();
      const at = caretBeforePickRef.current;
      if (at !== null) setCaretAtOffset(el, at);
      else {
        // Каретки не было (кнопку нажали, не заходя в текст) — фото в конец.
        const sel = document.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      // execCommand, а не ручная правка DOM: вставка попадает в стек отмены.
      document.execCommand('insertHTML', false, `<img src="${dataUrl}" alt="">`);
      touch();
    },
    [toast, touch],
  );

  /** Файл — вложение под текстом, чанками в noteFiles (см. lib/noteFiles). */
  const addFile = useCallback(
    async (file: File) => {
      if (file.size > MAX_FILE_BYTES) {
        toast(t('Файл больше {size} — выберите поменьше', { size: formatFileSize(MAX_FILE_BYTES) }));
        return;
      }
      const dataUrl = await new Promise<string>((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result));
        fr.onerror = () => rej(new Error('read'));
        fr.readAsDataURL(file);
      }).catch(() => null);
      if (dataUrl === null) {
        toast(t('Не удалось прочитать файл. Попробуйте другой'));
        return;
      }
      const id = await ensureNote();
      if (!id) return;
      const chunks = planNoteFileChunks(
        id,
        uid(),
        { name: file.name || t('файл'), mime: file.type, size: file.size },
        dataUrl,
      );
      for (const chunk of chunks) await create(db.noteFiles, chunk);
    },
    [ensureNote, toast],
  );

  /** Удалить вложение: мягко, каждый чанк — синк разнесёт удаление по
   *  устройствам так же, как разносил сам файл. */
  const deleteAttachment = useCallback(async (fileId: string) => {
    if (!window.confirm(t('Удалить файл из заметки?'))) return;
    const rows = await db.noteFiles.where('fileId').equals(fileId).toArray();
    for (const r of rows) await remove(db.noteFiles, r.id);
  }, []);

  // «Камера» следует за текстом: при наборе курсор уезжает под клавиатуру /
  // панель форматирования, а контейнер сам не скроллится — докручиваем
  // #app-scroll так, чтобы каретка оставалась в видимой зоне.
  const keepCaretVisible = useCallback(() => {
    requestAnimationFrame(() => {
      const scroller = document.getElementById('app-scroll');
      const el = editorRef.current;
      const sel = document.getSelection();
      if (!scroller || !el || !sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) return;
      const range = sel.getRangeAt(0).cloneRange();
      range.collapse(false);
      let rect = range.getBoundingClientRect();
      if (rect.height === 0 && rect.width === 0) {
        // Пустая строка: у схлопнутого range нет геометрии — берём её у блока строки.
        const node = sel.anchorNode;
        const near = node instanceof Element ? node : node?.parentElement;
        if (!near) return;
        rect = near.getBoundingClientRect();
      }
      // Видимая зона: visualViewport учитывает клавиатуру iOS; снизу вычитаем
      // панель форматирования (если она выше края вьюпорта), сверху — шапку.
      const vv = window.visualViewport;
      const vvBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
      const toolbarTop = toolbarRef.current?.getBoundingClientRect().top ?? Infinity;
      const bottom = Math.min(vvBottom, toolbarTop) - 12;
      const top = (vv?.offsetTop ?? 0) + 108;
      if (rect.bottom > bottom) scroller.scrollTop += rect.bottom - bottom;
      else if (rect.top < top) scroller.scrollTop -= top - rect.top;
    });
  }, []);

  // Автонумерация как в задачах: Enter после строки «N. текст» начинает новую
  // с «N+1. »; Enter на пустом пункте «N. » убирает маркер (выход из списка).
  // Настоящие <ol>/<ul> (кнопка в тулбаре) браузер продолжает сам — не трогаем.
  const handleEditorKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) {
      if (e.key === 'Enter') keepCaretVisible();
      return;
    }
    const el = editorRef.current;
    const sel = document.getSelection();
    if (!el || !sel || sel.rangeCount === 0 || !sel.isCollapsed) return;
    const anchor = sel.anchorNode;
    if (!anchor || !el.contains(anchor)) return;
    // Каретка «между блоками» (anchorNode — сам редактор): iOS так ставит её
    // после Enter на пустой строке. Автонумерации тут нет — обычный перенос.
    if (anchor === el) {
      keepCaretVisible();
      return;
    }
    const host = anchor instanceof Element ? anchor : anchor.parentElement;
    if (host?.closest('li')) {
      keepCaretVisible();
      return; // внутри настоящего списка нумерацию ведёт браузер
    }
    // Блок текущей строки — ближайший предок, чей родитель сам редактор
    // (строки contentEditable — это <div>; первая строка — голые текст-узлы).
    // КРИТИЧНО не выйти за пределы редактора: range шире него превратил бы
    // «стирание маркера» в удаление куска страницы (мёртвый UI до перезагрузки).
    let block: Node = anchor;
    while (block.parentNode !== el) {
      if (!block.parentNode) {
        keepCaretVisible();
        return; // структура неожиданная — не трогаем DOM
      }
      block = block.parentNode;
    }
    const r = document.createRange();
    r.setStart(block, 0);
    r.setEnd(anchor, sel.anchorOffset);
    const line = r.toString();
    const m = /^(\d+)\.\s(.*)$/.exec(line);
    if (!m) {
      keepCaretVisible();
      return; // строка не вида «N. …» — обычный перенос
    }
    e.preventDefault();
    const [, numStr, rest] = m;
    if (rest.trim() === '') {
      // Пустой пункт — стираем маркер и остаёмся на строке.
      sel.removeAllRanges();
      sel.addRange(r);
      document.execCommand('delete');
    } else {
      document.execCommand('insertParagraph');
      document.execCommand('insertText', false, `${Number(numStr) + 1}. `);
    }
    touch();
    keepCaretVisible();
  };

  // Сохранение при уходе со страницы.
  useEffect(
    () => () => {
      clearTimeout(timerRef.current);
      void flush();
    },
    [flush],
  );

  // Голосовой ввод: дописываем распознанный текст в конец заметки и
  // запускаем тот же автосейв, что и обычный набор (touch → flush).
  const appendVoice = useCallback(
    (text: string) => {
      const el = editorRef.current;
      if (!el) return;
      const existing = (el.innerText ?? '').trim();
      el.appendChild(document.createTextNode((existing ? ' ' : '') + text));
      touch();
    },
    [touch],
  );

  /** Выполнить блочную операцию, сохранив позицию каретки.
   *
   *  Обёртка, а не копипаста внутрь exec(): чек-лист — не execCommand-команда,
   *  у него свой toggleChecklist, и он проходил МИМО починки каретки. Получалось,
   *  что «Маркированный список» ведёт себя правильно, а «Список задач» рядом —
   *  по-старому, хотя это самая ходовая кнопка в редакторе. */
  const withCaret = (run: () => void) => {
    const el = editorRef.current;
    const sel0 = document.getSelection();
    const safeToRestore =
      Boolean(el) &&
      Boolean(sel0?.isCollapsed) &&
      caretLineHasText(el!) &&
      !caretAtLineStart(el!);
    const before = safeToRestore ? caretOffset(el!) : null;
    run();
    if (el) {
      el.focus();
      if (before !== null) setCaretAtOffset(el, before);
    }
    syncActive();
    touch();
  };

  const exec = (command: string, value?: string) => {
    const el = editorRef.current;
    // Куда смотрела каретка ДО команды. Нужно, потому что дальше идёт focus(),
    // а фокус на контейнере, потерявшем выделение, ставит каретку в САМОЕ
    // НАЧАЛО. Из-за этого «написал заголовок → нажал список» превращало
    // следующий набор в ввод перед существующим текстом: «Покупки» + «молоко»
    // давало «МолокоПокупки» одним пунктом.
    // Смещение запоминаем только когда возвращать его действительно надо и
    // безопасно. Три условия, и каждое стоило отдельного дефекта:
    //
    //  · строка непустая — на пустой смещение неотличимо от конца предыдущей;
    //  · каретка НЕ в начале строки — там та же ничья: «конец строки N» и
    //    «начало строки N+1» дают одно число, а setCaretAtOffset разрешает её
    //    в пользу предыдущего узла. Из-за этого набор после кнопки списка
    //    падал в конец прошлой строки, а прошлая строка — часто заголовок
    //    заметки: в списке появлялось «Покупкихлеб»;
    //  · выделение схлопнуто — иначе восстановление убивает само выделение, и
    //    повторное нажатие (которым здесь снимают формат) применяло его к
    //    заголовку вместо снятия с выделенных строк.
    const sel0 = document.getSelection();
    const safeToRestore =
      Boolean(el) &&
      Boolean(sel0?.isCollapsed) &&
      caretLineHasText(el!) &&
      !caretAtLineStart(el!);
    const before = safeToRestore ? caretOffset(el!) : null;

    // тег-based разметка (<b>/<i>), иначе на Gecko execCommand даёт
    // <span style> и наш санитайзер срезал бы форматирование
    document.execCommand('styleWithCSS', false, 'false');
    // Повторное нажатие на блочный формат снимает его: без этого из
    // подзаголовка или цитаты нельзя выйти, не удаляя строку.
    if (command === 'formatBlock' && value) {
      const sel = document.getSelection();
      const host = sel?.anchorNode instanceof Element ? sel.anchorNode : sel?.anchorNode?.parentElement;
      const already = host?.closest(value);
      document.execCommand('formatBlock', false, already ? 'div' : value);
    } else {
      document.execCommand(command);
    }

    if (el) {
      el.focus();
      // Возвращаем каретку после команд, ПЕРЕСОБИРАЮЩИХ блок. Они уносят её в
      // начало нового контейнера — формально каретка не потеряна, но стоит не
      // там, где человек её оставил. Смещение считается по видимому тексту,
      // поэтому переживает смену обёрток <div> → <li>.
      //
      // Инлайновые команды (жирный, курсив, зачёркивание) сюда не входят
      // намеренно: они работают с выделением, и навязывать им схлопнутую
      // каретку значило бы снимать выделение после каждого нажатия.
      if (BLOCK_COMMANDS.has(command) && before !== null) setCaretAtOffset(el, before);
    }
    syncActive();
    touch();
  };

  const togglePin = () => {
    setPinned((p) => !p);
    touch();
  };

  const handleDelete = async () => {
    if (!window.confirm(t('Удалить заметку?'))) return;
    deletedRef.current = true;
    clearTimeout(timerRef.current);
    if (savedIdRef.current) await remove(db.notes, savedIdRef.current);
    navigate('/notes');
  };

  // «Готово»: гасим отложенный автосейв, сохраняем текущее состояние и уходим.
  const handleDone = async () => {
    clearTimeout(timerRef.current);
    await flush();
    navigate('/notes');
  };

  return (
    <Screen
      title=""
      backTo="/notes"
      backLabel={t('Заметки')}
      right={
        <div className="flex items-center gap-1">
          <MicButton onText={appendVoice} />
          <IconButton
            icon={Pin}
            label={pinned ? t('Открепить') : t('Закрепить')}
            onClick={togglePin}
            tone={pinned ? 'accent' : 'muted'}
            filled={pinned}
          />
          <IconButton icon={Trash2} label={t('Удалить')} onClick={() => void handleDelete()} tone="danger" />
          <button
            onClick={() => void handleDone()}
            className="pl-1 pr-1 font-semibold text-accent active:opacity-60"
          >
            {t('Готово')}
          </button>
        </div>
      }
    >
      {/* Дата изменения по центру над текстом — фирменная строка Apple Notes:
          тихий факт вместо интерфейса, живёт прямо в листе заметки. */}
      {editedAt && (
        <p className="mb-2 text-center text-xs text-muted">
          {format(
            new Date(editedAt),
            getLang() === 'ru' ? "d MMMM yyyy 'г'., HH:mm" : 'MMMM d, yyyy · HH:mm',
            { locale: dateLocale() },
          )}
        </p>
      )}

      {remoteChanged && (
        <p className="mb-3 rounded-xl bg-warning/10 px-3 py-2 text-xs leading-snug text-warning">
          {t('Заметку изменили на другом устройстве. Пока вы печатаете, мы её не трогаем — ваш текст сохранится поверх.')}
        </p>
      )}

      <Hint
        id="note-editor-tricks"
        title={t('Редактор заметок')}
        className="mb-3"
        items={[
          { icon: Type, text: <>{t('Первая строка — заголовок заметки')}</> },
          { icon: ListOrdered, text: <>{t('Начните строку с «1. » — Enter продолжит нумерацию сам')}</> },
          { icon: SlidersHorizontal, text: <>{t('«Aa» внизу — стили текста; рядом чек-лист, фото и файл')}</> },
        ]}
      />

      {/* data-placeholder: ключ «Заголовок» занят стилем текста ('Heading') —
          плейсхолдер первой строки по-английски зовётся 'Title', ветка явная. */}
      <div
        ref={editorRef}
        className="note-editor"
        contentEditable
        suppressContentEditableWarning
        autoCapitalize="sentences"
        autoCorrect="on"
        spellCheck
        data-placeholder={getLang() === 'en' ? 'Title' : 'Заголовок'}
        onPaste={(e) => {
          // Чистим вставку ДО попадания в DOM: иначе <img onerror>/скрипт из
          // буфера может сработать раньше санитайза-на-сохранении (XSS).
          e.preventDefault();
          const html = e.clipboardData.getData('text/html');
          const text = e.clipboardData.getData('text/plain');
          // Простой текст — БУКВАЛЬНО: раньше он шёл в insertHTML сырым, и
          // символы разметки из буфера (ответы ИИ полны «a<b», «&amp;»,
          // числовых сущностей) интерпретировались: куски текста глотались,
          // сущности превращались в кашу символов, переносы строк слипались
          // (\n для HTML — пробел). Экранируем и переводим \n в <br> руками.
          const literal = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\n/g, '<br>');
          const clean = html ? sanitizeNoteHtml(html) : literal;
          document.execCommand('insertHTML', false, clean);
          // Вставленная разметка приносит свои <div>/<p>, и первая строка
          // оказывается внутри блока — то есть перестаёт быть заголовком.
          // Из мессенджера (только plain text) этого не видно, из браузера и
          // документов — видно всегда.
          if (editorRef.current) normalizeEditor(editorRef.current);
          touch();
        }}
        onPointerDown={(e) => {
          // Тап по галочке переключает пункт. Ловим на pointerdown, а не на
          // click: click внутри contenteditable уже переставил каретку, и
          // отменять это поздно — экран дёргается.
          const li = closestChecklistItem(e.target as Node);
          if (!li || !hitCheckbox(li, e.clientX)) return;
          e.preventDefault();
          toggleItem(li);
          touch();
        }}
        onKeyDown={handleEditorKeyDown}
        onInput={() => {
          touch();
          keepCaretVisible();
        }}
        onBlur={() => {
          clearTimeout(timerRef.current);
          void flush();
        }}
      />

      {/* Файлы-вложения — под текстом. Картинки живут в самом тексте. */}
      <NoteAttachments files={attachments} onDelete={(fid) => void deleteAttachment(fid)} />

      {/* Одно скрытое поле выбора на всё вложение.
          
          Было два — «Фото» (accept="image/*") и «Файл» (без accept), — и они
          делали разное: первое вставляло картинку в текст, второе клало файл
          вложением под текстом. Но выбор-то идёт в СИСТЕМНОМ меню iOS, а оно
          у обоих начинается с «Медиатеки»: отличить их в момент выбора нельзя,
          и фото, выбранное через «Файл», приезжало вложением вместо текста.
          Человек видел две кнопки, делающие на вид одно и то же.
          
          Теперь кнопка одна, а куда попадёт выбранное — решает тип файла:
          картинка идёт в текст (так ведут себя все заметочники), остальное —
          вложением. accept не ставим: без него системное меню даёт и
          «Медиатеку», и «Снять фото», и «Выбрать файл» — все пути из одного
          места. value сбрасывается, чтобы повторный выбор того же файла
          сработал. */}
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          if (f.type.startsWith('image/')) void addPhoto(f);
          else void addFile(f);
        }}
      />

      {/* Распорка под перекрытие снизу: панель форматирования + клавиатура.
          Без неё скролл упирается, когда последние строки ещё лежат под
          панелью, — низ заметки физически нельзя было увидеть. 76px — полоса
          (~64px с safe-area) с запасом, раскрытая панель «Aa» добавляет свои
          ~124px; клавиатурная часть — живая, от useKeyboardInset. */}
      <div aria-hidden style={{ height: keyboardInset + 76 + (formatOpen ? 124 : 0) }} />

      {/* Панель форматирования над клавиатурой (таб-бар на этом экране скрыт).
          fixed bottom-0 на iOS клавиатура просто накрывает (fixed живёт в
          layout-вьюпорте) — поднимаем панель на её высоту через translateY. */}
      <div
        ref={toolbarRef}
        className="fixed inset-x-0 bottom-0 z-40 border-t border-hairline bg-surface p-2 pb-[calc(env(safe-area-inset-bottom)+8px)]"
        style={{ position: 'fixed', transform: keyboardInset > 0 ? `translateY(-${keyboardInset}px)` : undefined }}
      >
        {/* Панель «Aa»: стили абзаца показаны собственной типографикой —
            «Заголовок» жирный, «Цитата» курсивная. Слова вместо иконок:
            подпись не нуждается в расшифровке. */}
        {formatOpen && (
          <div className="animate-fade-in mx-auto mb-2 w-full max-w-lg space-y-2" data-testid="format-panel">
            <div className="flex gap-1 rounded-2xl bg-surface-2 p-1">
              <button
                type="button"
                aria-label={t('Подзаголовок')}
                aria-pressed={active.h2}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => exec('formatBlock', 'h2')}
                className={`min-h-11 flex-1 rounded-xl text-base font-bold transition-colors ${
                  active.h2 ? 'bg-accent/15 text-accent' : 'text-text active:bg-elevated'
                }`}
              >
                {t('Заголовок')}
              </button>
              <button
                type="button"
                aria-label={t('Обычный текст')}
                aria-pressed={!active.h2 && !active.quote}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => exec('formatBlock', 'div')}
                className={`min-h-11 flex-1 rounded-xl text-sm transition-colors ${
                  !active.h2 && !active.quote ? 'bg-accent/15 text-accent' : 'text-text active:bg-elevated'
                }`}
              >
                {t('Обычный')}
              </button>
              <button
                type="button"
                aria-label={t('Цитата')}
                aria-pressed={active.quote}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => exec('formatBlock', 'blockquote')}
                className={`min-h-11 flex-1 rounded-xl text-sm italic transition-colors ${
                  active.quote ? 'bg-accent/15 text-accent' : 'text-text active:bg-elevated'
                }`}
              >
                {t('Цитата')}
              </button>
            </div>
            <div className="flex items-center justify-between gap-1">
              <ToolBtn onClick={() => exec('bold')} label={t('Жирный')} active={active.bold} className="flex-1">
                <GBold size={ICON.header} strokeWidth={STROKE_STRONG} />
              </ToolBtn>
              <ToolBtn onClick={() => exec('italic')} label={t('Курсив')} active={active.italic} className="flex-1">
                <GItalic size={ICON.header} strokeWidth={STROKE_STRONG} />
              </ToolBtn>
              <ToolBtn onClick={() => exec('strikeThrough')} label={t('Зачёркнутый')} active={active.strike} className="flex-1">
                <GStrike size={ICON.header} strokeWidth={STROKE_STRONG} />
              </ToolBtn>
              <span aria-hidden className="mx-1 h-6 w-px shrink-0 bg-hairline" />
              <ToolBtn onClick={() => exec('insertUnorderedList')} label={t('Маркированный список')} active={active.ul} className="flex-1">
                <List size={ICON.header} strokeWidth={STROKE_STRONG} />
              </ToolBtn>
              <ToolBtn onClick={() => exec('insertOrderedList')} label={t('Нумерованный список')} active={active.ol} className="flex-1">
                <ListOrdered size={ICON.header} strokeWidth={STROKE_STRONG} />
              </ToolBtn>
            </div>
          </div>
        )}

        {/* Полоса: пять входов без скролла — стили за «Aa», рядом чек-лист,
            фото, файл и отмена. Ровно то, что нужно чаще всего. */}
        <div className="mx-auto flex w-full max-w-lg items-center justify-around">
          <ToolBtn
            onClick={() => setFormatOpen((v) => !v)}
            label={t('Формат')}
            active={formatOpen}
            bare
          >
            <span className="text-[19px] font-semibold leading-none tracking-tight">Aa</span>
          </ToolBtn>
          <ToolBtn
            onClick={() =>
              withCaret(() => {
                const el = editorRef.current;
                if (el) {
                  el.focus();
                  toggleChecklist(el);
                }
              })
            }
            label={t('Список задач')}
            active={active.checklist}
            bare
          >
            <ListChecks size={ICON.header} strokeWidth={STROKE_STRONG} />
          </ToolBtn>
          <ToolBtn
            onClick={() => {
              // Позицию каретки запоминаем сейчас: пикер уведёт фокус, и к
              // моменту выбора файла выделение уже будет потеряно. Нужна она
              // только картинке — но какой файл выберут, здесь ещё неизвестно.
              caretBeforePickRef.current = editorRef.current ? caretOffset(editorRef.current) : null;
              fileInputRef.current?.click();
            }}
            label={t('Вложить')}
            bare
          >
            <GAttach size={ICON.header} strokeWidth={STROKE_STRONG} />
          </ToolBtn>
          <ToolBtn onClick={() => exec('undo')} label={t('Отменить')} bare>
            <Undo2 size={ICON.header} strokeWidth={STROKE_STRONG} />
          </ToolBtn>
        </div>
        <span
          className={`pointer-events-none absolute right-3 -top-6 text-xs font-medium text-muted transition-opacity ${
            saved ? 'opacity-100' : 'opacity-0'
          }`}
        >
          {t('Сохранено')}
        </span>
      </div>
    </Screen>
  );
}
