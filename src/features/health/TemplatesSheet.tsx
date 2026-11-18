import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Sheet } from '../../components/ui/Sheet';
import { Button } from '../../components/ui/Button';
import { AutoGrowTextarea, Field, Input } from '../../components/ui/Input';
import { GChevronDown, GPencil, GPlus } from '../../components/ui/glyphs';
import { ICON } from '../../components/ui/icons';
import { HIT_SLOP_44 } from '../../components/ui/hitSlop';
import { t } from '../../lib/i18n';
import type { WorkoutTemplate } from '../../db/types';
import {
  addTemplate,
  removeTemplate,
  saveTemplateOrder,
  templateOrderChanges,
  updateTemplate,
  useTemplates,
  withTemplateOrder,
  type TemplateDraft,
} from './templateRepo';
import { useHoldToReorder } from '../tasks/useHoldToReorder';
import { DRAG_START_THRESHOLD, DROP_HYSTERESIS, getScrollParent, placeGhost } from '../tasks/dragTuning';
import { autoScrollStep } from '../tasks/autoScroll';
import { buzz } from '../../lib/feedback';
import { ItemFields } from './ItemFields';
import { DurationWheel } from './DurationWheel';
import { itemFromSaved, kindPending, newItem, savedFromItem, type Item } from './workoutItem';
import { formatDuration } from '../../lib/duration';
import { templateSummary } from './workoutText';
import { unlockTick } from './tick';
import { confirmAction } from '../../components/ui/confirmStore';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Шаблон выбран для загрузки в форму тренировки. */
  onPick: (tpl: WorkoutTemplate) => void;
}

/** Список шаблонов: тап — выбрать (загрузить в форму тренировки), карандаш —
 *  открыть на правку, внизу — завести новый. Удаление — внутри шаблона, а не
 *  в списке: рядом с выбором его задевали бы случайно. Убрать лишние виды из
 *  выбранного — уже в самой форме тренировки: там видно, что сегодня реально
 *  делали, а что нет. Канва design/sport-templates. */
export function TemplatesSheet({ open, onClose, onPick }: Props) {
  // null — список; 'new' — новый шаблон; иначе — шаблон на правке.
  const [editing, setEditing] = useState<WorkoutTemplate | 'new' | null>(null);
  const dirty = useRef(false);
  const list = useTemplates();
  // Список ↔ редактор — другой экран в той же шторке: начинается сверху.
  // Иначе карандаш у нижнего шаблона открывал редактор с середины, а
  // название, время и памятка оставались за верхним краем.
  const top = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    top.current?.closest('.overflow-y-auto')?.scrollTo(0, 0);
  }, [editing]);

  const back = () => {
    dirty.current = false;
    setEditing(null);
  };
  const close = async () => {
    // Шаблон на тридцать упражнений набирают долго: случайный свайп вниз не
    // должен стирать набранное молча (PROTOCOL §5.5). Вопрос — тот же, что у
    // задачи (TaskEditSheet).
    if (
      editing &&
      dirty.current &&
      !(await confirmAction({ title: t('Закрыть без сохранения?'), confirmLabel: t('Закрыть без сохранения') }))
    )
      return;
    back();
    onClose();
  };

  return (
    <Sheet open={open} onClose={() => void close()} title={editing === 'new' ? t('Новый шаблон') : editing ? t('Шаблон') : t('Шаблоны тренировок')}>
      <div ref={top} />
      {open && !editing && list && (
        <TemplateList list={list} onPick={onPick} onEdit={setEditing} onNew={() => setEditing('new')} />
      )}
      {open && editing && (
        <TemplateEditor
          key={editing === 'new' ? 'new' : editing.id}
          template={editing === 'new' ? null : editing}
          onDone={back}
          onDirty={(d) => {
            dirty.current = d;
          }}
        />
      )}
    </Sheet>
  );
}

type At = { x: number; y: number; pointerId: number };

/** Запретить прокрутку пальцем на время переноса; вернёт «снять запрет».
 *  touch-action, выставленный после начала касания, iOS не применяет —
 *  поэтому ещё и touchmove окна гасится (как у переноса в «Задачах»). */
function lockPageScroll(): () => void {
  const prev = document.body.style.touchAction;
  const block = (e: TouchEvent) => e.preventDefault();
  // passive: false — иначе preventDefault на касании не сработает.
  window.addEventListener('touchmove', block, { passive: false });
  document.body.style.touchAction = 'none';
  return () => {
    window.removeEventListener('touchmove', block);
    document.body.style.touchAction = prev;
  };
}

/** Список шаблонов. Перенос — удержанием строки (канва design/template-order,
 *  вариант А, 17.11.2026): тот же жест, что у папок «Заметок» и проектов
 *  «Задач» (useHoldToReorder, 400 мс). Тап по-прежнему выбирает шаблон — клик
 *  после удачного удержания хук гасит сам. Пока палец ведёт, раскладка под
 *  ним не меняется: строка на старом месте гаснет, линия «встанет сюда» лежит
 *  поверх строк без своей высоты, у пальца — плашка с названием (PROTOCOL
 *  §6.3). Порядок один на список и чипы карточки дня (useTemplates). */
function TemplateList({
  list,
  onPick,
  onEdit,
  onNew,
}: {
  list: WorkoutTemplate[];
  onPick: (tpl: WorkoutTemplate) => void;
  onEdit: (tpl: WorkoutTemplate) => void;
  onNew: () => void;
}) {
  // Новый порядок — в том же кадре, что снимает линию, до ответа базы.
  // Накладка помнит список, от которого построена: ответ базы (или чужая
  // правка по синку) приходит новым списком — и она больше не действует.
  const [pending, setPending] = useState<{ base: WorkoutTemplate[]; rows: WorkoutTemplate[] } | null>(null);
  const shown = pending?.base === list ? pending.rows : list;
  const [drag, setDrag] = useState<{ id: string; name: string; insert: number | null } | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const ptr = useRef({ x: 0, y: 0 });
  // Снять идущий жест: слушатели окна, цикл кадров, запрет прокрутки. Зовётся
  // и при размонтировании — шторку могут закрыть, не дождавшись пальца.
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);

  const startReorder = (tpl: WorkoutTemplate, at: At) => {
    if (stop.current) return; // один жест за раз: второй палец не ведёт свой
    buzz(); // «взял» — только Android (PROTOCOL §6.4)
    const rows = shown;
    ptr.current = { x: at.x, y: at.y };
    let insert: number | null = null;
    let moved = false;
    let raf = 0;
    const rowEl = (id: string) => document.querySelector<HTMLElement>(`[data-template-id="${id}"]`);
    const scroller = getScrollParent(rowEl(tpl.id));
    // Сколько строк над пальцем = перед какой встанет. Люфт у середины строки
    // (DROP_HYSTERESIS): дрожь пальца на границе не перекидывает линию.
    const indexAt = (y: number) => {
      let idx = 0;
      rows.forEach((row, i) => {
        const el = rowEl(row.id);
        if (!el) return;
        const r = el.getBoundingClientRect();
        const lag = insert == null ? 0 : i < insert ? -DROP_HYSTERESIS : DROP_HYSTERESIS;
        if (y > r.top + r.height / 2 + lag) idx++;
      });
      return idx;
    };
    const aim = () => {
      const idx = indexAt(ptr.current.y);
      if (idx === insert) return;
      insert = idx;
      setDrag({ id: tpl.id, name: tpl.name, insert: idx });
    };
    // Длинный список не влезает в шторку: у краёв она докручивается сама —
    // прокрутка пальцем на время жеста заблокирована.
    const tick = () => {
      if (moved && scroller) {
        const box = scroller.getBoundingClientRect();
        // Верх зоны — под липкой шапкой шторки: иначе до разгона вверх не дотянуться.
        const head = scroller.querySelector<HTMLElement>(':scope > .sticky');
        const step = autoScrollStep(ptr.current.y, head ? head.getBoundingClientRect().bottom : box.top, box.bottom);
        if (step) {
          scroller.scrollTop += step;
          aim();
        }
      }
      raf = requestAnimationFrame(tick);
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== at.pointerId) return;
      e.preventDefault();
      ptr.current = { x: e.clientX, y: e.clientY };
      placeGhost(ghostRef.current, e.clientX, e.clientY);
      if (!moved && Math.hypot(e.clientX - at.x, e.clientY - at.y) < DRAG_START_THRESHOLD) return;
      moved = true;
      aim();
    };
    let unlock = () => {};
    const end = () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', cancel);
      unlock();
      stop.current = null;
      setDrag(null);
    };
    const finish = (e: PointerEvent) => {
      if (e.pointerId !== at.pointerId) return;
      end();
      if (insert == null) return; // удержание без движения — ничего
      const changes = templateOrderChanges(rows, tpl.id, insert);
      if (changes.length === 0) return; // отпустил там же
      buzz(); // «положил» — только Android, не на отмене и не на «там же»
      setPending({ base: list, rows: withTemplateOrder(rows, changes) });
      // Запись не легла — накладку снять, иначе экран показывал бы порядок,
      // которого в базе нет, а следующий перенос считался бы от него; ошибка
      // уходит дальше, как у задач (TasksPage).
      saveTemplateOrder(changes).catch((err: unknown) => {
        setPending(null);
        throw err;
      });
    };
    // Системный обрыв жеста (звонок, шторка уведомлений) — не «отпустил
    // здесь»: переноса нет, как у проектов в «Задачах».
    const cancel = (e: PointerEvent) => {
      if (e.pointerId === at.pointerId) end();
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', cancel);
    unlock = lockPageScroll();
    stop.current = end;
    setDrag({ id: tpl.id, name: tpl.name, insert: null });
    raf = requestAnimationFrame(tick);
  };

  const reorderable = shown.length > 1;
  return (
    <div className="space-y-2 pb-2">
      {shown.length === 0 ? (
        <p className="py-4 text-center text-sm text-lh-text-secondary">{t('Шаблонов пока нет.')}</p>
      ) : (
        <p className="pb-1 text-sm leading-snug text-lh-text-secondary">
          {reorderable
            ? t('Выберите шаблон — тренировка заполнится сама. Удерживайте шаблон, чтобы переставить. Карандаш — изменить.')
            : t('Выберите шаблон — тренировка заполнится сама. Карандаш — изменить.')}
        </p>
      )}
      {shown.map((tpl, i) => {
        const at = drag?.insert;
        const line = at == null ? null : at === i ? 'top' : at === shown.length && i === shown.length - 1 ? 'bottom' : null;
        return (
          <TemplateRow
            key={tpl.id}
            tpl={tpl}
            dimmed={drag?.id === tpl.id}
            line={line}
            onPick={() => onPick(tpl)}
            onEdit={() => onEdit(tpl)}
            onReorderStart={reorderable ? (p) => startReorder(tpl, p) : undefined}
          />
        );
      })}
      <button
        type="button"
        onClick={onNew}
        className="flex w-full items-center justify-center gap-1.5 rounded-2xl border border-dashed border-lh-border-strong py-3 font-medium text-lh-accent active:opacity-70"
      >
        <GPlus size={ICON.action} /> {t('Новый шаблон')}
      </button>
      {/* Плашка у пальца — в body: у панели шторки свой transform, и fixed
          внутри неё считался бы от панели, а не от экрана. */}
      {drag &&
        createPortal(
          <div
            ref={(el) => {
              ghostRef.current = el;
              placeGhost(el, ptr.current.x, ptr.current.y);
            }}
            className="pointer-events-none fixed top-0 left-0 z-[70] will-change-transform"
            data-testid="template-ghost"
          >
            <div className="max-w-[78vw] -translate-y-1/2 translate-x-3 truncate rounded-xl border border-lh-accent bg-lh-surface-2 px-3 py-2 text-sm font-semibold opacity-95 shadow-lg shadow-black/30">
              {drag.name}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

/** Строка шаблона: тап — выбрать, удержание — перенос, карандаш — правка.
 *  Хук удержания — на строку, поэтому строка отдельным компонентом. */
function TemplateRow({
  tpl,
  dimmed,
  line,
  onPick,
  onEdit,
  onReorderStart,
}: {
  tpl: WorkoutTemplate;
  dimmed: boolean;
  line: 'top' | 'bottom' | null;
  onPick: () => void;
  onEdit: () => void;
  onReorderStart: ((at: At) => void) | undefined;
}) {
  const { headerProps } = useHoldToReorder(onReorderStart, onPick);
  return (
    // Узел строки для замера при переносе ищется по атрибуту: ref кнопки
    // уже принадлежит хуку.
    <div data-template-id={tpl.id} className="relative">
      {/* Линия — поверх строк, посреди зазора в 8px (space-y-2), своей высоты
          не имеет: список под пальцем не сдвигается (PROTOCOL §6.3). */}
      {line && (
        <span
          aria-hidden
          data-testid="template-drop-line"
          className={`pointer-events-none absolute inset-x-4 z-[1] h-1 rounded-full bg-lh-accent ${line === 'top' ? '-top-1.5' : '-bottom-1.5'}`}
        />
      )}
      <div className={`flex items-center gap-1 rounded-2xl border border-lh-border-strong py-1 pl-3 pr-1 ${dimmed ? 'opacity-40' : ''}`}>
        {/* select-none и без выноски iOS: удержание не выделяет текст и не
            открывает системное меню поверх переноса. */}
        <button
          type="button"
          {...headerProps}
          className="min-h-11 min-w-0 flex-1 py-2 text-left select-none active:opacity-70 [-webkit-touch-callout:none] [-webkit-user-select:none]"
        >
          <span className="block font-medium leading-snug wrap-anywhere">{tpl.name}</span>
          <span className="block text-sm text-lh-text-secondary">{templateSummary(tpl)}</span>
        </button>
        <button
          type="button"
          onClick={onEdit}
          className="flex size-11 shrink-0 items-center justify-center text-lh-text-secondary active:opacity-60"
          aria-label={t('Изменить шаблон «{name}»', { name: tpl.name })}
        >
          <GPencil size={ICON.base} />
        </button>
      </div>
    </div>
  );
}

/** Блок редактора: номер и заголовок. Порядок «название → упражнения →
 *  дополнительно» виден сразу, и блоки не сливаются в одну стену полей
 *  (канва design/template-steps, вариант А, 16.11.2026). */
function Step({ n, title, hint, children }: { n: number; title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="lh-section flex items-baseline gap-2 px-1">
        <span className="tabular-nums text-lh-accent">{n}</span>
        <span>{title}</span>
        {hint && <span className="ml-auto text-xs normal-case tracking-normal">{hint}</span>}
      </h3>
      {children}
    </section>
  );
}

/** Шаблон — новый или на правке — теми же полями вида, что в форме тренировки
 *  (ItemFields): свои виды, упражнения с подходами, весом и отдыхом внутри
 *  вида, минуты и км по желанию. Обязательно только название. */
function TemplateEditor({
  template,
  onDone,
  onDirty,
}: {
  template: WorkoutTemplate | null;
  onDone: () => void;
  onDirty: (dirty: boolean) => void;
}) {
  const [name, setName] = useState(template?.name ?? '');
  const [note, setNote] = useState(template?.note ?? '');
  const [total, setTotal] = useState(template?.totalMinutes ?? 0);
  const [wheelOpen, setWheelOpen] = useState(false);
  // Новый шаблон стартует с пустых минут: время тут по желанию, а подставленные
  // «45 мин» силовой пришлось бы стирать в каждом шаблоне из упражнений.
  // Вид свёрнут до строки «● Силовая» и у нового: стена из десяти чипов
  // стояла раньше кнопки «+ Упражнение». Сохранённый читают как программу.
  const [items, setItems] = useState<Item[]>(() =>
    template ? template.items.map((i) => itemFromSaved(i, true)) : [{ ...newItem('strength', ''), collapsed: true }],
  );
  const savingRef = useRef(false);

  // Пустые время и памятка — `undefined`: при правке поле уходит из записи.
  const draft: TemplateDraft = {
    name: name.trim(),
    items: items.map(savedFromItem),
    totalMinutes: total > 0 ? total : undefined,
    note: note.trim() || undefined,
  };
  const canSave = draft.name.length > 0 && items.length > 0 && !kindPending(items);

  // «Изменено» — по тому, что уйдёт в запись, а не по касаниям: раскрыл и
  // свернул строку — шаблон тот же, вопроса при закрытии нет.
  const snapshot = JSON.stringify(draft);
  const initial = useRef(snapshot);
  useEffect(() => {
    onDirty(snapshot !== initial.current);
  }, [snapshot, onDirty]);

  async function save() {
    if (!canSave || savingRef.current) return;
    savingRef.current = true;
    try {
      if (template) await updateTemplate(template.id, draft);
      else await addTemplate(draft);
      onDone();
    } finally {
      savingRef.current = false;
    }
  }

  async function del() {
    if (!template) return;
    if (!(await confirmAction({ title: t('Удалить шаблон «{name}»?', { name: template.name }), message: t('Записанные тренировки останутся.') }))) return;
    await removeTemplate(template.id);
    onDone();
  }

  // Порядок — как думают о тренировке: как назвать → что делать → детали.
  // Время и памятка раньше стояли первыми, до единого упражнения.
  return (
    <div className="space-y-6 pb-2">
      <Step n={1} title={t('Название')}>
        <Input
          value={name}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
          aria-label={t('Название шаблона')}
          placeholder={t('Например, «День ног»')}
          maxLength={60}
        />
      </Step>
      <Step n={2} title={t('Упражнения')}>
        {items.map((it) => (
          <ItemFields
            key={it.key}
            item={it}
            removable={items.length > 1}
            onRemove={() => setItems((prev) => prev.filter((x) => x.key !== it.key))}
            onChange={(patch) => setItems((prev) => prev.map((x) => (x.key === it.key ? { ...x, ...patch } : x)))}
          />
        ))}
        {/* Второй вид приходит раскрытым: выбрать вид — первое, что с ним делают. */}
        <button
          type="button"
          onClick={() => setItems((prev) => [...prev, newItem('strength', '')])}
          className={`flex items-center gap-1 self-start rounded-full border border-dashed border-lh-border-strong px-3.5 py-1.5 text-sm font-medium text-lh-accent active:opacity-70 ${HIT_SLOP_44}`}
        >
          <GPlus size={ICON.inline} /> {t('Другой вид тренировки')}
        </button>
      </Step>
      <Step n={3} title={t('Дополнительно')} hint={t('по желанию')}>
        <div className="rounded-2xl border border-lh-border-strong px-3 pb-3">
          <button
            type="button"
            onClick={() => {
              // Тап — тот самый жест, которым iOS разрешает звук щелчка.
              unlockTick();
              setWheelOpen((o) => !o);
            }}
            aria-expanded={wheelOpen}
            aria-label={total > 0 ? t('Общее время: {time}', { time: formatDuration(total) }) : t('Общее время: не задано')}
            className="flex min-h-11 w-full items-center gap-2 py-1 text-left active:opacity-70"
          >
            <span className="flex-1 font-medium">{t('Общее время')}</span>
            <span className={`tabular-nums ${total > 0 ? 'text-lh-text-primary' : 'text-lh-text-secondary'}`}>{total > 0 ? formatDuration(total) : t('не задано')}</span>
            <GChevronDown size={ICON.inline} className={`shrink-0 text-lh-text-secondary transition-transform ${wheelOpen ? 'rotate-180' : ''}`} />
          </button>
          {wheelOpen && <DurationWheel value={total} onChange={setTotal} />}
          {/* Общее время — время плана. Сводки считают минуты видов из записи:
              без них тренировка по шаблону даёт «0 ч за месяц» — говорим сразу. */}
          {total > 0 && draft.items.every((i) => i.minutes === 0) && (
            <p className="mt-1.5 text-xs leading-snug text-lh-text-secondary">
              {t('В часы за месяц идут минуты видов — укажите их по тапу на название вида.')}
            </p>
          )}
          <div className="mt-2 border-t border-lh-border pt-3">
            <Field label={t('Памятка')}>
              <AutoGrowTextarea
                value={note}
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setNote(e.target.value)}
                placeholder={t('Правила, прогрессия')}
                maxLength={2000}
              />
            </Field>
          </div>
        </div>
      </Step>
      <div className="flex gap-3">
        {template && (
          <Button variant="danger" className="shrink-0" onClick={() => void del()}>
            {t('Удалить')}
          </Button>
        )}
        {/* При правке — короткое «Сохранить»: рядом с «Удалить» длинная
            подпись на экране 320 рвалась на две строки. */}
        <Button className="min-w-0 flex-1" disabled={!canSave} onClick={() => void save()}>
          {template ? t('Сохранить') : t('Сохранить шаблон')}
        </Button>
      </div>
    </div>
  );
}
