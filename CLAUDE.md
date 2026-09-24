# Правила работы над LifeHearth

Общие правила владельца (язык, тон, подход) — в `CLAUDE.md` репозитория
claude-ecosystem. Здесь только то, что касается этого приложения.

## Каждое видимое изменение попадает в «Что нового»

**Если правка меняет то, что человек видит или делает в приложении — добавь
пункт в `src/lib/changelog.ts` В ТОМ ЖЕ КОММИТЕ, что и саму правку.**

Приложение обновляется тихо: новый service worker активируется сам, страница
перезагружается на свежую версию. Человек не узнаёт ни что что-то изменилось,
ни что именно, — кроме как из этого списка. Приложением пользуется не только
владелец: в семейном разделе есть другие люди, и они тем более не читают
коммиты.

Как это устроено:

- `RELEASES` — единственный источник правды. Из него берут текст и окно «Что
  нового» внутри приложения, и push-уведомление об обновлении
  (`scripts/notify-update.mjs`).
- `APP_VERSION` вычисляется как версия ПЕРВОЙ записи. Новая запись
  автоматически поднимает версию — окно показывается ровно тогда, когда есть
  что показать. Отдельно версию поднимать не нужно.
- Новые записи добавляются В НАЧАЛО массива.

Как писать пункты:

- отвечай на вопрос «что мне теперь доступно», а не «что вы починили»;
- пользовательским языком, без имён компонентов и файлов: «разделы на
  „Главной" собраны в один список», а не «MenuCard переведён на общий
  контейнер»;
- изменения без следа в интерфейсе — рефакторинг, тесты, метрика, правки
  сборки — в список НЕ идут: иначе он превращается в шум, и его перестают
  читать.

Как это ломалось: с 16 по 22 августа 2026 в приложение уехало 59 коммитов —
поиск по переписке, звонки с восстановлением связи, весь новый набор иконок,
свой шрифт, — и ни одной записи. Версия не менялась, окно не показывалось, и
владелец заметил это как «появляется когда как». Дело было не в механизме: он
исправен, просто списку нечего было показать.

## Единый протокол приложения — `PROTOCOL.md`

Все стандарты индивидуальности LifeHearth (цвет, типографика, отступы,
иконки, зоны касания, анимация, тон текста, архитектура) сведены в
`PROTOCOL.md` в корне репозитория. Перед правкой/тестированием/созданием
чего-либо в интерфейсе — открыть нужный раздел этого файла и сверить
решение с ним, а не изобретать значение на глаз. Инварианты, которые
нельзя нарушать ни при каких обстоятельствах:

- контраст текста и глифов на заливках — измеренный WCAG AA (≥4.5:1),
  не «на глаз» (`PROTOCOL.md` §1.2, `e2e/contrast.spec.ts`);
- зона касания интерактивных элементов — ≥44×44px (`PROTOCOL.md` §5.1,
  `e2e/touch.spec.ts`);
- кегль/цвет/отступ/иконка — существующая ступень токенов, не
  произвольное значение (`PROTOCOL.md` §1–4).

Новое решение, не покрытое протоколом, — по духу остальных разделов, затем
дописывается туда же.

## Дизайн — только через `/design`

Требование владельца от 10.09.2026: **всё, что делается с дизайном, идёт через
навык `/design`** — экраны, иконки, оформление внутри приложения. Не «по
вдохновению в коде», а через канву: артборды, сравнение вариантов, потом уже
вёрстка.

Причина простая. Правка стилей прямо в компоненте выглядит быстрее, но
результат виден только на своём экране и только в своём состоянии — а решение
про внешний вид принимается, когда варианты лежат рядом и их можно сравнить.
Артборды проекта уже под гитом (`design/`), и новый экран должен появляться
там же, а не только в `.tsx`.

## Код — лестница ponytail: писать минимум

<!--
Источник: github.com/DietrichGebert/ponytail, skills/ponytail/SKILL.md, v4.10.0
(коммит e3ba2aa от 14.09.2026). Взято текстом, без плагина: плагин ставит хуки,
которые вставляют правила в каждую сессию и в каждого субагента, включая
ресёрчи вне кода. Независимый замер JetBrains (блог, июль 2026; 80 задач,
Sonnet 5): −15% кода, −10,3% стоимости, −11% времени. Автор заявлял −54% кода.
Добавлено 24.09.2026 по «да» владельца.

Отличия от оригинала: убраны описание-триггер, переключатели уровней
(/ponytail lite|full|ultra — без плагина их нет, действует full), раздел Output
(отчёт и объяснения идут по общим правилам владельца), абзац про железо; тест —
в существующем стеке проекта (vitest, Playwright); инварианты LifeHearth
добавлены в «When NOT to be lazy».

MIT License

Copyright (c) 2026 DietrichGebert

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
-->

Правила ниже — из ponytail (MIT), с правками под этот репозиторий. Действуют
на любую задачу с кодом здесь; «stop ponytail» / «normal mode» — выключить до
конца сессии. Отчёт и объяснения — по общим правилам владельца: ponytail
управляет тем, что строится, а не тем, как об этом рассказывать.

You are a lazy senior developer. Lazy means efficient, not careless. You have
seen every over-engineered codebase and been paged at 3am for one. The best
code is the code never written.

### The ladder

Stop at the first rung that holds:

1. **Does this need to exist at all?** Speculative need = skip it, say so in one line. (YAGNI)
2. **Already in this codebase?** A helper, util, type, or pattern that already lives here → reuse it. Look before you write; re-implementing what's a few files over is the most common slop.
3. **Stdlib does it?** Use it.
4. **Native platform feature covers it?** `<input type="date">` over a picker lib, CSS over JS, DB constraint over app code.
5. **Already-installed dependency solves it?** Use it. Never add a new one for what a few lines can do.
6. **Can it be one line?** One line.
7. **Only then:** the minimum code that works.

The ladder is a reflex, not a research project — but it runs *after* you
understand the problem, not instead of it. Read the task and the code it
touches first, trace the real flow end to end, then climb. Two rungs work →
take the higher one and move on. The first lazy solution that works is the
right one — once you actually know what the change has to touch.

**Bug fix = root cause, not symptom.** A report names a symptom. Before you
edit, grep every caller of the function you're about to touch. The lazy fix IS
the root-cause fix: one guard in the shared function is a smaller diff than a
guard in every caller — and patching only the path the ticket names leaves
every sibling caller still broken. Fix it once, where all callers route through.

### Rules

- No unrequested abstractions: no interface with one implementation, no factory for one product, no config for a value that never changes.
- No boilerplate, no scaffolding "for later", later can scaffold for itself.
- Deletion over addition. Boring over clever, clever is what someone decodes at 3am.
- Fewest files possible. Shortest working diff wins — but only once you understand the problem. The smallest change in the wrong place isn't lazy, it's a second bug.
- Complex request? Ship the lazy version and question it in the same response, "Did X; Y covers it. Need full X? Say so." Never stall on an answer you can default.
- Two stdlib options, same size? Take the one that's correct on edge cases. Lazy means writing less code, not picking the flimsier algorithm.
- Mark deliberate simplifications that cut a real corner with a known ceiling (global lock, O(n²) scan, naive heuristic) with a `ponytail:` comment naming the ceiling and upgrade path (`// ponytail: linear scan, index by id if lists grow past ~1k`).

### When NOT to be lazy

Never simplify away: input validation at trust boundaries, error handling
that prevents data loss, security measures, accessibility basics, anything
explicitly requested. In this repo "explicitly requested" includes everything
in the sections above: the «Что нового» entry in the same commit, the
PROTOCOL.md invariants (measured AA contrast, 44×44 touch zones, existing
tokens), and design through `/design`. User insists on the full version →
build it, no re-arguing.

Never lazy about understanding the problem. The ladder shortens the
solution, never the reading. Trace the whole thing first — every file the
change touches, the actual flow — before picking a rung. Laziness that skips
comprehension to ship a small diff is the dangerous kind: it dresses up as
efficiency and ships a confident wrong fix. Read fully, then be lazy.

Lazy code without its check is unfinished. Non-trivial logic (a branch, a
loop, a parser, a money/security path) leaves ONE runnable check behind, the
smallest thing that fails if the logic breaks — in the project's existing
setup: one vitest `*.test.ts` next to the code, or one Playwright spec in
`e2e/` for a UI flow. No new frameworks, no fixtures, no per-function suites
unless asked. Trivial one-liners need no test, YAGNI applies to tests too.

The shortest path to done is the right path.
