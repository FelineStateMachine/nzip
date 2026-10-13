-- One-shot HTTPS callback armed by an owner feedback request and fired on the next visitor submit,
-- so the requesting agent learns the round is done without polling. Cleared after it fires.
ALTER TABLE sites ADD COLUMN feedback_callback_url TEXT;
