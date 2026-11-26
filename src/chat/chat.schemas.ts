import { z } from 'zod';

export const createConversationSchema = z.object({
  title: z.string().trim().min(1).max(200).default('New conversation'),
});
export type CreateConversationDto = z.infer<typeof createConversationSchema>;

export const sendMessageSchema = z.object({
  text: z.string().trim().min(1).max(4_000),
});
export type SendMessageDto = z.infer<typeof sendMessageSchema>;
