-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "frameCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "hasFullSnapshot" BOOLEAN NOT NULL DEFAULT false;
