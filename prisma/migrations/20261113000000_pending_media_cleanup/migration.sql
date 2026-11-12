-- Deleted accounts whose Cloudinary uploads are still to be removed
-- (userMediaCleanupService.js). Additive: a new, empty table.

-- CreateTable
CREATE TABLE "pending_media_cleanup" (
    "id"         BIGSERIAL NOT NULL,
    "user_id"    BIGINT NOT NULL,
    "attempts"   INTEGER NOT NULL DEFAULT 0,
    "last_error" VARCHAR(500),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_media_cleanup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pending_media_cleanup_user_id_key" ON "pending_media_cleanup"("user_id");
