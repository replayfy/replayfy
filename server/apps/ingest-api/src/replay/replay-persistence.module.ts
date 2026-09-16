import { Module } from "@nestjs/common";
import { PlaylistsModule } from "../playlists/playlists.module";
import { CohortsModule } from "../cohorts/cohorts.module";
import { SignalsModule } from "../signals/signals.module";
import { ReplayPersistenceService } from "./replay-persistence.service";

@Module({
  imports: [PlaylistsModule, CohortsModule, SignalsModule],
  providers: [ReplayPersistenceService],
  exports: [ReplayPersistenceService],
})
export class ReplayPersistenceModule {}
