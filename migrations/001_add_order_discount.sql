-- 高風險變更：資料庫結構。必須同時提供 up 與 down。
-- 鎖定檢查：大表 ALTER 是否會鎖表？此處採「新增可為空的欄位 + 事後回填」，不停機。

-- UP
ALTER TABLE orders ADD COLUMN discount_percent INTEGER NULL;
ALTER TABLE orders ADD COLUMN idempotency_key TEXT NULL;
CREATE UNIQUE INDEX idx_orders_idempotency_key ON orders (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- DOWN
DROP INDEX IF EXISTS idx_orders_idempotency_key;
ALTER TABLE orders DROP COLUMN idempotency_key;
ALTER TABLE orders DROP COLUMN discount_percent;
