-- Суточные счётчики лимитов (worker/src/limits.js). Воркер создаёт таблицу
-- сам при первом обращении (CREATE TABLE IF NOT EXISTS), миграция — для
-- порядка и для чистой базы. k — 'new:<хеш адреса>', 'ai:<аккаунт>',
-- 'aiip:<хеш адреса>'; IP открытым текстом не хранится.
CREATE TABLE IF NOT EXISTS usage_counters (
  k TEXT NOT NULL,
  day TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (k, day)
);
