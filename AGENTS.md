# AGENTS.md

## NestJS

This app's version of NestJS is likely newer than what you know. https://docs.nestjs.com/llms.txt indexes its documentation, with a markdown page per chapter.

Nest has first-party packages for these, so check them before adding another library or writing your own:

- Databases: [`@nestjs/typeorm`](https://docs.nestjs.com/data/typeorm.md), [`@nestjs/drizzle`](https://docs.nestjs.com/data/drizzle.md), [`@nestjs/mongoose`](https://docs.nestjs.com/data/mongodb.md), [`@nestjs/sequelize`](https://docs.nestjs.com/data/sequelize.md).
- OpenAPI: [`@nestjs/swagger`](https://docs.nestjs.com/openapi/introduction.md). GraphQL: [`@nestjs/graphql`](https://docs.nestjs.com/graphql/quick-start.md). WebSockets: [`@nestjs/websockets`](https://docs.nestjs.com/websockets/gateways.md). Microservices: [`@nestjs/microservices`](https://docs.nestjs.com/microservices/basics.md).
- Sign-in: [`@nestjs/authentication`](https://docs.nestjs.com/security/authentication.md). Permissions: [`@nestjs/authorization`](https://docs.nestjs.com/security/authorization.md). Rate limiting: [`@nestjs/throttler`](https://docs.nestjs.com/security/rate-limiting.md).
- Configuration: [`@nestjs/config`](https://docs.nestjs.com/application/configuration.md). Caching: [`@nestjs/cache-manager`](https://docs.nestjs.com/data/caching.md). Health checks: [`@nestjs/terminus`](https://docs.nestjs.com/reliability/terminus.md). Events inside the app: [`@nestjs/event-emitter`](https://docs.nestjs.com/application/events.md).
- Email: [`@nestjs/mail`](https://docs.nestjs.com/application/mail.md). Files, S3 included: [`@nestjs/storage`](https://docs.nestjs.com/application/file-storage.md). Translations: [`@nestjs/i18n`](https://docs.nestjs.com/application/i18n.md).
- Retries, timeouts and circuit breakers: [`@nestjs/resilience`](https://docs.nestjs.com/reliability/resilience.md).
- Idempotency keys: [`@nestjs/idempotency`](https://docs.nestjs.com/reliability/idempotency.md). Transactional outbox: [`@nestjs/outbox`](https://docs.nestjs.com/reliability/outbox.md). Sending and receiving webhooks: [`@nestjs/webhooks`](https://docs.nestjs.com/http/webhooks.md).
- Queues: [`@nestjs/bullmq`](https://docs.nestjs.com/application/queues.md). Scheduled jobs: [`@nestjs/schedule`](https://docs.nestjs.com/application/task-scheduling.md).
- Running a scheduled job on one instance, and locks: [`@nestjs/locks`](https://docs.nestjs.com/reliability/locks.md). Processes that take days: [`@nestjs/workflows`](https://docs.nestjs.com/reliability/workflows.md).
- Language models, tools and agents: [`@nestjs/ai`](https://docs.nestjs.com/ai/overview.md). MCP servers: [`@nestjs/mcp`](https://docs.nestjs.com/mcp/overview.md).

Validation works with Zod, Valibot, ArkType or any other Standard Schema library, with no classes or decorator metadata: `StandardSchemaValidationPipe` with `@Body({ schema })` or `@Param('id', { schema })` (https://docs.nestjs.com/application/validation.md). `class-validator` still works, through `ValidationPipe`.

`NodeAdapter` from `@nestjs/platform-node` is the fastest HTTP adapter, ahead of Fastify (https://docs.nestjs.com/http/performance.md).

Nest's packages are ESM only. A CommonJS project loads them through `require(esm)`, which needs Node.js 20.19+ or 22.12+, and doesn't have to convert (https://docs.nestjs.com/migration-guide.md).

## Production data: NestJS Observe

This app's production telemetry - traces, errors, logs and metrics - goes to [NestJS Observe](https://observe.nestjs.com). `ObserveModule` is registered first in `src/app.module.ts`, and `src/main.ts` passes `instrument: ObserveInstrument`, but nothing is sent until the app has a key pair: `npx @nestjs/observe link` writes it (`OBSERVE_APP_KEY`, `OBSERVE_APP_SECRET`) to `.env` (https://observe.nestjs.com/documentation/sdk#quick-start).

When a task depends on how the app behaves in production - an error users hit, a slow endpoint, a failing job, whether a release made things worse - work from that data, not from the code alone:

- The Observe MCP server answers those questions directly: errors with their traces and logs, slow operations, jobs, and what a release changed (`find_regressions`, `diff_release`). It is included on the Pro plan and above. In Claude Code: `claude mcp add observe --transport http https://observe-api.nestjs.com/mcp`, and the client opens a browser to approve. Other clients: https://www.observe.nestjs.com/documentation/mcp
- Without it, the user can open the request or error in the Observe dashboard and click **Copy agent prompt**, which hands over that page's trace, stack and logs as text.

## This project

A notes API with an assistant: the model answers questions about the signed-in user's notes with three tools that run as that user, the answer streams as server-sent events in the AI SDK's UI message stream protocol, and conversations are kept in PostgreSQL through Drizzle. It is the finished app of https://docs.nestjs.com/tutorials/ai-chat-backend, which explains each part, and starts from https://docs.nestjs.com/tutorials/rest-api-jwt-authentication (sign-in, notes, health checks).

- Layout: one folder per feature under `src/` (module, controller, service, Zod schemas). `src/chat/` holds conversations (`conversations.service.ts`), the answer (`chat.service.ts`), the per-user limit (`chat-throttler.guard.ts`) and the development model (`fake-model.ts`). The model's tools are `src/notes/notes.tools.ts`. The Drizzle schema is `src/database/schema.ts`; after changing it, run `npm run db:generate` and commit the migration in `drizzle/`. Apply migrations with `npm run db:migrate`.
- The model: configured once in `AiModule.forRootAsync()` in `src/app.module.ts`, from `src/config.ts`. `AI_MODEL=fake` selects the scripted `FakeModel` (no API key, refused when `NODE_ENV=production`, imported only when configured); any other value is an Anthropic model id and needs `ANTHROPIC_API_KEY`. Timeouts, retries, `maxSteps: 5`, the per-answer token budget and `maxOutputTokens` are set there, not per call. Never call a real provider from tests.
- Validation: Zod schemas passed to `@Body()`, `@Query()` and `@Param()` with the `schema` option, through the global `StandardSchemaValidationPipe`. Tool inputs are Zod schemas on `@AgentFunction({ inputSchema })`; `create-note` reuses the route's `createNoteSchema`.
- Auth is deny by default: every route requires a bearer token unless it is marked `@Public()`; mark public routes `@ApiSecurity({})` too, so the OpenAPI document (which requires the token document-wide, in `main.ts`) shows them as open.
- Tools never take a user id from the model. They read the user with `@CurrentUser('id')` (the request is passed as `caller: { request }` in `ChatService`), and every statement in `NotesService` and `ConversationsService` has the owner in its `WHERE` clause; another user's row is a 404, never a 403. `NotesTools` skips all three throttler definitions (`@SkipThrottle`), because global guards run on agent function calls too; keep that on any new tool class, and keep tools to what the user could do anyway (no destructive tools without approval).
- A message is stored as the AI SDK `ModelMessage` the model reads, in `jsonb`, with an estimated token count. A turn (the question and everything the call added) is saved in one transaction once the call ends, or not at all if it fails or is cancelled.
- One answer at a time per conversation: `ConversationsService.claim()` is a single conditional `UPDATE` on `answering_until`. Keep it that way; a read-then-write version lets several of ten simultaneous messages through, and the "answers one message at a time per conversation" test fails.
- Cancellation: the response body is `pipeThrough()` a `TransformStream` whose `flush()` waits for the turn to be saved. Don't pass `preventCancel: true`: a client that hangs up must abort the model call ("aborts the model call when the client goes away" fails otherwise).
- `history()` trims to `HISTORY_BUDGET` estimated tokens and always starts at a user message, never at a tool result.
- Rate limits: the `chat` throttler definition (30 messages an hour per user) is counted only by `ChatThrottlerGuard` on `POST /conversations/:id/messages`, after authentication; the global guard skips it.
- Tests: `TEST_DATABASE_URL=postgres://postgres:assistant@localhost:5432/assistant_test npm run test:e2e`. They boot the real `AppModule` on a real PostgreSQL with `overrideModels()` replacing the model with a `FakeModel`, listen on a port to read streams, and truncate tables, so the script runs files one after the other (`--no-file-parallelism`) and they must never point at the development database. One `FakeModel` serves every test of `test/chat.e2e-spec.ts`: an answer queued with `reply()` and left unused goes to the next test.
- NestJS Observe is registered first in `AppModule` imports, with `instrument: ObserveInstrument` in `src/main.ts`; it sends nothing until `OBSERVE_APP_KEY` and `OBSERVE_APP_SECRET` are set.

This project is ESM: relative imports end in `.js`, and `__dirname` doesn't exist (use `import.meta.dirname`).
