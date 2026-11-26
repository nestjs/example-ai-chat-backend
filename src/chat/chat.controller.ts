import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import type { NodeRequest } from '@nestjs/platform-node';
import { z } from 'zod';
import { ChatThrottlerGuard } from './chat-throttler.guard.js';
import {
  createConversationSchema,
  sendMessageSchema,
  type CreateConversationDto,
  type SendMessageDto,
} from './chat.schemas.js';
import { ChatService } from './chat.service.js';
import { ConversationsService } from './conversations.service.js';

const conversationId = { schema: z.uuid() };

@Controller('conversations')
export class ChatController {
  constructor(
    private readonly conversationsService: ConversationsService,
    private readonly chatService: ChatService,
  ) {}

  @Post()
  create(@CurrentUser('id') userId: string, @Body({ schema: createConversationSchema }) dto: CreateConversationDto) {
    return this.conversationsService.create(userId, dto.title);
  }

  @Get()
  findAll(@CurrentUser('id') userId: string) {
    return this.conversationsService.findAll(userId);
  }

  @Get(':id')
  findOne(@CurrentUser('id') userId: string, @Param('id', conversationId) id: string) {
    return this.conversationsService.findOne(userId, id);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@CurrentUser('id') userId: string, @Param('id', conversationId) id: string) {
    return this.conversationsService.remove(userId, id);
  }

  // Answers with a stream of server-sent events, which Nest sends as the model writes them.
  @Post(':id/messages')
  @UseGuards(ChatThrottlerGuard)
  send(
    @CurrentUser('id') userId: string,
    @Param('id', conversationId) id: string,
    @Body({ schema: sendMessageSchema }) { text }: SendMessageDto,
    @Req() request: NodeRequest,
  ) {
    return this.chatService.answer(userId, id, text, request);
  }
}
