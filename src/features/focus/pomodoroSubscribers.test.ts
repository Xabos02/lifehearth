import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Сторож: на тикающее время подписывается только тот, кто его показывает.
//
// Пока контекст помодоро был один, значение пересобиралось дважды в секунду, и
// вместе с ним перерисовывался каждый подписчик — включая форму задачи и
// кнопку «+», которым от таймера нужны только действия. Владелец видел это как
// «дёргается экран приложения во время письма продолжительного»: он печатал
// длинный текст, а шёл сеанс фокуса.
//
// Правило простое и проверяемое: зовёшь usePomodoro — обязан показывать время
// (formatClock или само remainingMs). Не показываешь — бери usePomodoroActions,
// и тик тебя не тронет.

function sources(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sources(full, acc);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) acc.push(full);
  }
  return acc;
}

describe('подписка на таймер фокуса', () => {
  it('usePomodoro зовёт только тот, кто показывает время', () => {
    const offenders: string[] = [];
    for (const file of sources('src')) {
      const code = readFileSync(file, 'utf8');
      if (!/\busePomodoro\s*\(/.test(code)) continue;
      // Сам модуль контекста — не подписчик.
      if (file.endsWith('pomodoro.ts')) continue;
      const showsTime = /formatClock|remainingMs/.test(code);
      if (!showsTime) offenders.push(file.replace(/^src\//, ''));
    }
    expect(
      offenders,
      `эти экраны подписаны на тикающее время, но его не показывают — им нужен usePomodoroActions:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('сторож видит нарушение, а не молчит на любом коде', () => {
    // Проверка самого сторожа: правило должно ловить файл, который зовёт
    // usePomodoro() и нигде не упоминает время.
    const fake = "const p = usePomodoro();\nreturn <div>{p.phase}</div>;";
    expect(/\busePomodoro\s*\(/.test(fake)).toBe(true);
    expect(/formatClock|remainingMs/.test(fake)).toBe(false);
  });
});
