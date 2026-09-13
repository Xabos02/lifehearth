import { describe, expect, it } from 'vitest';
import { ALARM_OPTIONS, alarmOption } from './alarms';
import { NOISE_OPTIONS, noiseLabel } from './noise';

// Каталоги звуков: то, что видит человек в списках. Юниты держат их
// целостность — синтез слушается руками, а не тестом.

describe('мелодии', () => {
  it('пятнадцать разных, «Без звука» первая, у остальных длительность', () => {
    expect(ALARM_OPTIONS).toHaveLength(15);
    expect(new Set(ALARM_OPTIONS.map((a) => a.value)).size).toBe(15);
    expect(new Set(ALARM_OPTIONS.map((a) => a.label)).size).toBe(15);
    expect(ALARM_OPTIONS[0].value).toBe('none');
    for (const a of ALARM_OPTIONS.slice(1)) expect(a.seconds).toBeGreaterThan(0);
  });

  it('незнакомый вид падает на «Мягкий», не на пустоту', () => {
    expect(alarmOption('nope' as never).value).toBe('soft');
  });
});

describe('шумы', () => {
  it('двенадцать разных, «Тишина» первая', () => {
    expect(NOISE_OPTIONS).toHaveLength(12);
    expect(new Set(NOISE_OPTIONS.map((n) => n.value)).size).toBe(12);
    expect(NOISE_OPTIONS[0].value).toBe('none');
    expect(noiseLabel('rain')).toBe('Дождь');
    expect(noiseLabel('nope' as never)).toBe('Тишина');
  });
});
