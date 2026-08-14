-- Optional expiry on API keys -- so a contractor's integration dies on its
-- own schedule instead of relying on someone remembering to revoke it.
-- NULL means the key never expires; verification refuses a past expires_at
-- with the same uniform 401 as a revoked or unknown key.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at DATETIME NULL AFTER revoked_at;
