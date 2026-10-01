-- A dismissal can be taken back. An added column, not a rebuilt table, so the
-- DuplicateDismissal triggers of the library projection migration stay.

-- AlterTable
ALTER TABLE "DuplicateDismissal" ADD COLUMN "revokedAt" DATETIME;
