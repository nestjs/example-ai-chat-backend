import { Injectable } from '@nestjs/common';
import { AgentFunction, type AgentFunctionContext } from '@nestjs/ai';
import { CurrentUser } from '@nestjs/authentication';
import { SkipThrottle } from '@nestjs/throttler';
import { z } from 'zod';
import type { Note } from '../database/schema.js';
import { createNoteSchema, type CreateNoteDto } from './notes.schemas.js';
import { NotesService } from './notes.service.js';

/** What the model reads about a note: no owner, no internal columns. */
const view = ({ id, title, body, updatedAt }: Note) => ({ id, title, body, updatedAt });

// Global guards run on agent function calls too, and the throttler's would count
// every call of every user as one client: the chat route is limited instead.
@SkipThrottle({ default: true, account: true, chat: true })
@Injectable()
export class NotesTools {
  constructor(private readonly notesService: NotesService) {}

  @AgentFunction({
    name: 'search-notes',
    description: "Search the user's notes for a word or phrase, in titles and bodies. Returns up to 10, newest first.",
    inputSchema: z.object({
      query: z.string().trim().min(1).max(100).describe('A word or phrase to look for, such as "dentist"'),
    }),
  })
  async search({ query }: { query: string }, _ctx: AgentFunctionContext, @CurrentUser('id') userId: string) {
    const found = await this.notesService.search(userId, query);
    return found.map(view);
  }

  @AgentFunction({
    name: 'read-note',
    description: "Read one of the user's notes in full, by its id.",
    inputSchema: z.object({ noteId: z.uuid().describe('The id of a note, from search-notes') }),
  })
  async read({ noteId }: { noteId: string }, _ctx: AgentFunctionContext, @CurrentUser('id') userId: string) {
    // Someone else's note is "Note not found", as on GET /notes/:id.
    return view(await this.notesService.findOne(userId, noteId));
  }

  @AgentFunction({
    name: 'create-note',
    description: 'Save a new note for the user, when they ask you to remember or write something down.',
    inputSchema: createNoteSchema,
  })
  async create(dto: CreateNoteDto, _ctx: AgentFunctionContext, @CurrentUser('id') userId: string) {
    return view(await this.notesService.create(userId, dto));
  }
}
