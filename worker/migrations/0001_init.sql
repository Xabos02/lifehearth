-- LifeHearth: схема E2E-синхронизации (D1 / SQLite).
-- Применять: wrangler d1 migrations apply life-hub-sync  (--local для теста).

-- Аккаунты: один на пользователя. token_hash = SHA-256 от bearer-токена.
-- accountId — неугадываемый UUID (часть пакета сопряжения), поэтому первое
-- обращение регистрирует пару (TOFU); далее токен сверяется.
CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Записи: содержимое в ciphertext (зашифровано на устройстве), служебные поля
-- открыты — нужны для дельта-синка (updated_at) и мягкого удаления (deleted_at).
CREATE TABLE IF NOT EXISTS records (
  account_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  ciphertext TEXT NOT NULL,
  PRIMARY KEY (account_id, table_name, id)
);

-- Индекс под дельта-выборку «всё, что новее курсора».
CREATE INDEX IF NOT EXISTS idx_records_pull ON records (account_id, updated_at);
