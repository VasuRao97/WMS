-- Ground/Floor only: which stacked bin, going away from the aisle, a row
-- belongs to (1 = nearest the walkway). DB default 1 so every existing row
-- (Rack/Stillage included, where this is meaningless) reads as the common
-- single-tier case with no backfill needed.
ALTER TABLE "Location" ADD COLUMN "depthTier" INTEGER DEFAULT 1;
