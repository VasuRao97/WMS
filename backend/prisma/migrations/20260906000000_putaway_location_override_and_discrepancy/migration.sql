-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "allowPutawayLocationOverride" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "PutawayTrip" ADD COLUMN     "discrepancyReviewedAt" TIMESTAMP(3),
ADD COLUMN     "discrepancyReviewedById" TEXT;

-- AddForeignKey
ALTER TABLE "PutawayTrip" ADD CONSTRAINT "PutawayTrip_discrepancyReviewedById_fkey" FOREIGN KEY ("discrepancyReviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
