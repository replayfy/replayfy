-- Make the publishable key viewable on the Install page.
-- Stored ONLY for PUBLIC-scope keys (they ship in client app code, so no marginal
-- secrecy); SERVER and WEBHOOK keys leave this NULL and stay hash-only / shown-once.
ALTER TABLE "ApiKey" ADD COLUMN "publicKey" TEXT;
