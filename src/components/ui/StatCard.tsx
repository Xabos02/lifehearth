import type { ReactNode } from 'react';

/** Карточка блока статистики: заголовок и содержимое. Живёт в ui, а не на
 *  странице статистики: блоки для неё собираются в своих разделах (энергия —
 *  в features/energy), и им нужна та же рамка. */
export function StatCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card p-4">
      <h2 className="mb-2 px-1 text-xs font-medium tracking-wider text-lh-text-secondary uppercase">{title}</h2>
      {children}
    </section>
  );
}
