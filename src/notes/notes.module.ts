import { Module } from '@nestjs/common';
import { NotesController } from './notes.controller.js';
import { NotesService } from './notes.service.js';
import { NotesTools } from './notes.tools.js';

@Module({
  controllers: [NotesController],
  providers: [NotesService, NotesTools],
})
export class NotesModule {}
