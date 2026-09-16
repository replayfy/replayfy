import { Global, Module } from "@nestjs/common";
import { StorageService } from "./storage.service";

/**
 * Storage is a cross-cutting dependency (sessions, workspace-delete, the
 * frames pipeline, future media pipelines all need it), so it's marked
 * @Global. Providers inject StorageService directly without re-importing
 * per module.
 */
@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
