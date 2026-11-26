import { createAnthropic } from '@ai-sdk/anthropic';
import { Module, StandardSchemaValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { AiModule } from '@nestjs/ai';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthenticationModule } from '@nestjs/authentication';
import { DrizzleModule } from '@nestjs/drizzle';
import { createObserveModule } from '@nestjs/observe';
import { ThrottlerGuard, ThrottlerModule, hours, minutes, normalizeIp } from '@nestjs/throttler';
import { drizzle } from 'drizzle-orm/node-postgres';
import { accountEmail } from './auth/account-email.js';
import { AuthModule } from './auth/auth.module.js';
import { ChatModule } from './chat/chat.module.js';
import { envSchema, type Env } from './config.js';
import { HealthModule } from './health/health.module.js';
import { NotesModule } from './notes/notes.module.js';
import { UsersModule } from './users/users.module.js';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    // First, so it shuts down last and still sends what the other modules did.
    ObserveModule.forRoot({
      // Empty until `npx @nestjs/observe link` writes the key pair into .env: the SDK then sends nothing.
      appKey: process.env.OBSERVE_APP_KEY ?? '',
      appSecret: process.env.OBSERVE_APP_SECRET ?? '',
      serviceId: 'notes-assistant',
    }),
    ConfigModule.forRoot({ isGlobal: true, validationSchema: envSchema }),
    DrizzleModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        drizzle,
        connection: config.get('DATABASE_URL', { infer: true }),
      }),
    }),
    AuthenticationModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        accessToken: {
          key: config.get('JWT_SECRET', { infer: true }),
          issuer: 'notes-api',
          audience: 'notes-api',
          ttl: '15m',
        },
        refreshToken: { ttl: '30d', absoluteTtl: '90d' },
      }),
    }),
    AiModule.forRootAsync({
      isGlobal: true,
      inject: [ConfigService],
      useFactory: async (config: ConfigService<Env, true>) => {
        const modelId = config.get('AI_MODEL', { infer: true });
        const model =
          modelId === 'fake'
            ? // Loaded only when configured: production never imports the testing entry point.
              (await import('./chat/fake-model.js')).createFakeModel()
            : createAnthropic({ apiKey: config.get('ANTHROPIC_API_KEY', { infer: true }) })(modelId);
        return {
          models: {
            default: { model, maxOutputTokens: config.get('AI_MAX_OUTPUT_TOKENS', { infer: true }) },
          },
          defaults: {
            timeout: '30s',
            retry: { attempts: 3 },
            // Model calls per answer: the tools' results each take one more.
            maxSteps: 5,
            // Input and output tokens over all the model calls of one answer.
            budget: { maxTokens: 60_000 },
          },
        };
      },
    }),
    ThrottlerModule.forRoot([
      // Per IP address, on every route.
      { name: 'default', ttl: minutes(1), limit: 100 },
      // Per email and IP address, wherever the request body names an account.
      {
        name: 'account',
        ttl: minutes(15),
        limit: 5,
        skipIf: (context) => !accountEmail(context.switchToHttp().getRequest()),
        getTracker: (req) => `${accountEmail(req)}|${normalizeIp(req.ip)}`,
      },
      // Per user, on the chat route: counted by ChatThrottlerGuard, once the user is known.
      {
        name: 'chat',
        ttl: hours(1),
        limit: 30,
        skipIf: (context) => !context.switchToHttp().getRequest().user,
        getTracker: (req) => req.user.id,
      },
    ]),
    UsersModule,
    AuthModule,
    NotesModule,
    ChatModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_PIPE, useClass: StandardSchemaValidationPipe },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
