-- LifeHearth: облачная резервная копия аккаунта (E2E). Хранится только шифротекст.
-- Применять: wrangler d1 migrations apply life-hub-sync  (--local для теста).
-- Примечание: воркер также создаёт эту таблицу лениво (CREATE TABLE IF NOT EXISTS
-- в обработчике /backup/*), поэтому фича работает и без ручного применения миграции.

-- Модель latest-only: одна логическая копия на аккаунт, при необходимости
-- разбитая на чанки (лимит значения одной колонки D1 — 2 МБ).
CREATE TABLE IF NOT EXISTS backups (
  account_id TEXT NOT NULL,
  chunk      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  PRIMARY KEY (account_id, chunk)
);
