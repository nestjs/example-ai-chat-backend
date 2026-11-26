import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { ModelMessage } from 'ai';
import { and, asc, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { conversations, messages, type Conversation } from '../database/schema.js';

/** The most an answer may take, tools included: then its call is aborted, and the conversation freed. */
export const ANSWER_TIMEOUT_MS = 120_000;
/** A claim outlives its answer, so only a process that died mid-answer leaves one behind. */
const CLAIM_SECONDS = ANSWER_TIMEOUT_MS / 1000 + 30;
/** The history sent to the model, at most, in estimated tokens. */
const HISTORY_BUDGET = 8_000;

/** About four characters per token, for English text and JSON: an estimate, not the model's count. */
const estimateTokens = (message: ModelMessage) => Math.ceil(JSON.stringify(message.content).length / 4);

@Injectable()
export class ConversationsService {
  constructor(@InjectDrizzle() private readonly db: NodePgDatabase) {}

  async create(ownerId: string, title: string): Promise<Conversation> {
    const [conversation] = await this.db.insert(conversations).values({ ownerId, title }).returning();
    return conversation;
  }

  findAll(ownerId: string): Promise<Conversation[]> {
    return this.db
      .select()
      .from(conversations)
      .where(eq(conversations.ownerId, ownerId))
      .orderBy(desc(conversations.updatedAt))
      .limit(100);
  }

  async findOne(ownerId: string, id: string) {
    const [conversation] = await this.db.select().from(conversations).where(this.owned(ownerId, id));
    if (!conversation) {
      notFound();
    }
    const rows = await this.db
      .select({ content: messages.content, createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.conversationId, id))
      .orderBy(asc(messages.id));
    return { ...conversation, messages: rows.map(({ content, createdAt }) => ({ ...content, createdAt })) };
  }

  async remove(ownerId: string, id: string): Promise<void> {
    const deleted = await this.db
      .delete(conversations)
      .where(this.owned(ownerId, id))
      .returning({ id: conversations.id });
    if (deleted.length === 0) {
      notFound();
    }
  }

  /** Marks the conversation as answering, or throws: 404 if it isn't the owner's, 409 while another answer runs. */
  async claim(ownerId: string, id: string): Promise<void> {
    // One conditional statement: of two messages sent at once, one claims the conversation.
    const claimed = await this.db
      .update(conversations)
      .set({ answeringUntil: sql`now() + make_interval(secs => ${CLAIM_SECONDS})` })
      .where(
        and(
          this.owned(ownerId, id),
          // A claim past its time was left by a process that died mid-answer.
          or(isNull(conversations.answeringUntil), lt(conversations.answeringUntil, sql`now()`)),
        ),
      )
      .returning({ id: conversations.id });
    if (claimed.length === 0) {
      const [exists] = await this.db.select({ id: conversations.id }).from(conversations).where(this.owned(ownerId, id));
      if (!exists) {
        notFound();
      }
      throw new ConflictException('The assistant is still answering in this conversation');
    }
  }

  /** The latest messages that fit the budget, starting at a question of the user. */
  async history(id: string): Promise<ModelMessage[]> {
    const rows = await this.db
      .select({ content: messages.content, tokens: messages.tokens })
      .from(messages)
      .where(eq(messages.conversationId, id))
      .orderBy(desc(messages.id))
      .limit(200);
    const kept: ModelMessage[] = [];
    let total = 0;
    for (const { content, tokens } of rows) {
      if (total + tokens > HISTORY_BUDGET) {
        break;
      }
      total += tokens;
      kept.push(content);
    }
    // Cut at a user message: a tool result whose tool call was trimmed away is refused by providers.
    while (kept.length > 0 && kept[kept.length - 1].role !== 'user') {
      kept.pop();
    }
    return kept.reverse();
  }

  /** Saves a whole turn, the question and everything the call added, and frees the conversation. */
  async saveTurn(id: string, turn: ModelMessage[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      // One statement for the turn: its messages are stored together, in order, or not at all.
      await tx
        .insert(messages)
        .values(turn.map((content) => ({ conversationId: id, content, tokens: estimateTokens(content) })));
      await tx
        .update(conversations)
        .set({ answeringUntil: null, updatedAt: new Date() })
        .where(eq(conversations.id, id));
    });
  }

  /** Frees the conversation after an answer that failed or was cancelled. Nothing of the turn is kept. */
  async release(id: string): Promise<void> {
    await this.db.update(conversations).set({ answeringUntil: null }).where(eq(conversations.id, id));
  }

  private owned(ownerId: string, id: string) {
    return and(eq(conversations.id, id), eq(conversations.ownerId, ownerId));
  }
}

function notFound(): never {
  throw new NotFoundException('Conversation not found');
}
