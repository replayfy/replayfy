import { Module } from "@nestjs/common";
import { PlaylistsController } from "./playlists.controller";
import { PlaylistsService } from "./playlists.service";

@Module({
  controllers: [PlaylistsController],
  providers: [PlaylistsService],
  exports: [PlaylistsService],
})
export class PlaylistsModule {}
