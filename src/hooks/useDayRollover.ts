import { useEffect, useState } from 'react';
import { todayKey } from '../lib/dates';

/** Перерисовка на смене суток: «сегодня» считается при рендере, и без неё
 *  открытая с вечера страница утром показывала вчерашний день как «Сегодня».
 *  ponytail: опрос раз в минуту и сразу при возврате в приложение, а не
 *  таймер до полуночи — длинный таймер в фоне и во сне телефона сдвигается;
 *  открытый экран до минуты после полуночи ещё может показывать прежний день.
 *  Тот же день — тот же state, и React лишний раз не рисует. */
export function useDayRollover() {
  const [, setDay] = useState(todayKey);
  useEffect(() => {
    const roll = () => setDay(todayKey());
    const id = window.setInterval(roll, 60_000);
    document.addEventListener('visibilitychange', roll);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', roll);
    };
  }, []);
}
