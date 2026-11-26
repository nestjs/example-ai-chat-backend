import { Injectable, Logger } from '@nestjs/common';
import { AiModelError, AiService } from '@nestjs/ai';
import type { ModelMessage } from 'ai';
import { NotesTools } from '../notes/notes.tools.js';
import { ANSWER_TIMEOUT_MS, ConversationsService } from './conversations.service.js';

const instructions =
  "You are the assistant of a notes app. Answer from the user's notes: search them before you answer " +
  'a question about them, and say so when nothing matches. Save a note only when the user asks you to. ' +
  'Keep answers short.';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly ai: AiService,
    private readonly conversationsService: ConversationsService,
  ) {}

  /** Streams the answer to `text` as the AI SDK's UI message stream, and saves the turn once it's complete. */
  async answer(userId: string, conversationId: string, text: string, request: unknown): Promise<Response> {
    await this.conversationsService.claim(userId, conversationId);
    try {
      return await this.stream(conversationId, text, request);
    } catch (error) {
      await this.conversationsService.release(conversationId);
      throw error;
    }
  }

  private async stream(conversationId: string, text: string, request: unknown): Promise<Response> {
    const question: ModelMessage = { role: 'user', content: text };
    const history = await this.conversationsService.history(conversationId);
    const answer = this.ai.streamText({
      label: 'chat',
      instructions,
      messages: [...history, question],
      tools: [NotesTools],
      // The agent functions run as the user who sent the request.
      caller: { request },
      abortSignal: AbortSignal.timeout(ANSWER_TIMEOUT_MS),
    });

    // When the call ends, the whole turn is saved; when it fails or is cancelled, none of it is.
    const settled = answer.responseMessages
      .then(
        (added) => this.conversationsService.saveTurn(conversationId, [question, ...added]),
        () => this.conversationsService.release(conversationId),
      )
      .catch((error: unknown) => this.logger.error(`Could not save the turn of ${conversationId}`, error));

    const response = answer.toUIMessageStreamResponse({
      errorText: (error) =>
        error instanceof AiModelError ? 'The assistant is unavailable. Try again in a minute.' : 'Something went wrong.',
    });
    // The stream ends once the turn is saved, so the client's next message finds it in the history.
    const body = response.body!.pipeThrough(new TransformStream({ flush: () => settled }));
    return new Response(body, response);
  }
}
