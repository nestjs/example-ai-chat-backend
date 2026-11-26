import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';
import { ConversationsService } from './conversations.service.js';

@Module({
  controllers: [ChatController],
  providers: [ConversationsService, ChatService],
})
export class ChatModule {}
