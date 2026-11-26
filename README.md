# AI chat backend with NestJS

This is the finished application of the tutorial [Build an AI chat backend in Node.js that streams answers](https://docs.nestjs.com/tutorials/ai-chat-backend) in the NestJS documentation. The tutorial builds it step by step and explains every decision; this repository is the result, ready to clone.

## What it does

A notes API with an assistant. A signed-in user writes notes, starts conversations, and asks questions about the notes. The model looks them up with three tools (`search-notes`, `read-note`, `create-note`) that run as that user and can't reach anyone else's notes, and the answer streams to the client as server-sent events, in the AI SDK's UI message stream protocol that `useChat()` reads.

- The model is configured once, from the environment, through [`@nestjs/ai`](https://docs.nestjs.com/ai/overview), with timeouts, retries, a cap on the output tokens of each model call (`AI_MAX_OUTPUT_TOKENS`), at most five model calls per answer, and a budget of 60,000 tokens per answer.
- A client that goes away mid-answer aborts the model call. Nothing of that turn is saved.
- Conversations are kept in PostgreSQL. A conversation answers one message at a time (a second message gets a 409), and the model gets the latest history that fits a budget of about 8,000 tokens.
- Each user may send 30 messages an hour.
- Sign-in with access and refresh tokens, Zod validation, OpenAPI and health checks come from [Build a REST API with JWT authentication](https://docs.nestjs.com/tutorials/rest-api-jwt-authentication).

By default it runs on `FakeModel`, the scripted model of `@nestjs/ai/testing`, so you need no API key: it searches your notes for the last word of the question, then names the notes it found. The end-to-end tests use a `FakeModel` too.

## Run it

You need Node.js 22 or later, and Docker for PostgreSQL.

```bash
git clone https://github.com/nestjs/example-ai-chat-backend.git
cd example-ai-chat-backend
npm install
cp .env.example .env              # then set JWT_SECRET: openssl rand -base64 32
docker compose up -d
npm run db:migrate
npm run start
```

The API listens on http://localhost:3000, with Swagger UI at http://localhost:3000/docs. [Try it](https://docs.nestjs.com/tutorials/ai-chat-backend#try-it) in the tutorial walks through signing up, writing notes, and streaming an answer with curl.

### Use a real model

`.env.example` sets `AI_MODEL=fake`. For real answers from Anthropic, as in [Start from the JWT API](https://docs.nestjs.com/tutorials/ai-chat-backend#start-from-the-jwt-api), edit `.env`:

```bash
# Either your Anthropic API key...
ANTHROPIC_API_KEY=<your Anthropic API key>
# ...or the scripted model, which needs none (development only).
# AI_MODEL=fake
```

Without `AI_MODEL`, the model is `claude-opus-5-5`; set `AI_MODEL` to another Anthropic model id to use that one. The configuration is checked at startup: any model other than `fake` needs `ANTHROPIC_API_KEY`, and `NODE_ENV=production` refuses `fake` (see [Configure the model](https://docs.nestjs.com/tutorials/ai-chat-backend#configure-the-model)).

## Endpoints

| Endpoint | Section |
| --- | --- |
| `POST /auth/sign-up`, `POST /auth/token`, `POST /auth/token/refresh`, `POST /auth/token/revoke` | [Start from the JWT API](https://docs.nestjs.com/tutorials/ai-chat-backend#start-from-the-jwt-api) |
| `GET /me`, `GET /notes`, `GET /notes/:id`, `POST /notes`, `PATCH /notes/:id`, `DELETE /notes/:id` | [Start from the JWT API](https://docs.nestjs.com/tutorials/ai-chat-backend#start-from-the-jwt-api) |
| `GET /health/live`, `GET /health/ready` | [Start from the JWT API](https://docs.nestjs.com/tutorials/ai-chat-backend#start-from-the-jwt-api) |
| `POST /conversations`, `GET /conversations`, `GET /conversations/:id`, `DELETE /conversations/:id` | [Store conversations](https://docs.nestjs.com/tutorials/ai-chat-backend#store-conversations) |
| `POST /conversations/:id/messages` (server-sent events) | [Stream the answer](https://docs.nestjs.com/tutorials/ai-chat-backend#stream-the-answer), [Limit each user](https://docs.nestjs.com/tutorials/ai-chat-backend#limit-each-user) |
| `GET /docs` (Swagger UI) | [Start from the JWT API](https://docs.nestjs.com/tutorials/ai-chat-backend#start-from-the-jwt-api) |

Every route except `/auth/*`, `/health/*` and `/docs` needs an `Authorization: Bearer <access token>` header.

## Layout

| Path | What it holds |
| --- | --- |
| `src/main.ts` | bootstrap on the Node adapter, NestJS Observe instrumentation, JSON logs in production, security headers, CORS, Swagger UI |
| `src/app.module.ts` | NestJS Observe, config, database, authentication, the model (`AiModule`), the three throttler definitions, the validation pipe |
| `src/config.ts` | the environment schema, `AI_MODEL` and `ANTHROPIC_API_KEY` included |
| `src/database/schema.ts` | Drizzle tables: users, notes, refresh_tokens, conversations, messages |
| `src/auth/`, `src/users/`, `src/health/` | sign-in and health checks, from the JWT tutorial |
| `src/notes/` | the notes routes, and `notes.tools.ts`, the model's three tools |
| `src/chat/` | conversations, the streamed answer, the per-user limit, and the development `FakeModel` |
| `test/` | end-to-end tests on PostgreSQL |
| `drizzle/` | migrations |

## Tests

```bash
TEST_DATABASE_URL=postgres://postgres:assistant@localhost:5432/assistant_test npm run test:e2e
```

`docker compose` creates the `assistant_test` database. The tests truncate its tables, so never point them at your development database; the script runs the two test files one after the other for the same reason. They need no API key: `vitest.config.e2e.ts` sets `AI_MODEL=fake`, and `test/chat.e2e-spec.ts` puts a scripted `FakeModel` in place of the configured model. They check that the tools see only the user's notes, that the answer streams, that a client hanging up aborts the model call, that a conversation answers one message at a time, the history budget, retries and provider errors, and the per-user limit. `test/refresh-token.store.e2e-spec.ts` runs the refresh token store contract of `@nestjs/authentication`.

## Stack

[NestJS](https://nestjs.com) 12 on the Node adapter, [`@nestjs/ai`](https://docs.nestjs.com/ai/overview) with the [AI SDK](https://ai-sdk.dev) and its Anthropic provider, [Zod](https://zod.dev) validation, [`@nestjs/authentication`](https://docs.nestjs.com/security/authentication), [Drizzle](https://docs.nestjs.com/data/drizzle) and PostgreSQL, [`@nestjs/throttler`](https://docs.nestjs.com/security/rate-limiting), [`@nestjs/swagger`](https://docs.nestjs.com/openapi/introduction), [`@nestjs/terminus`](https://docs.nestjs.com/reliability/terminus), [NestJS Observe](https://docs.nestjs.com/observability/overview), and Vitest.

## Production

Read the tutorial's [production checklist](https://docs.nestjs.com/tutorials/ai-chat-backend#production-checklist) first.

[NestJS Observe](https://docs.nestjs.com/observability/overview) is already registered in `src/app.module.ts`, and sends nothing until it has a key pair: `npx @nestjs/observe link` writes `OBSERVE_APP_KEY` and `OBSERVE_APP_SECRET` into `.env`. It then records every model call on its span in the request's trace, with the model and the tokens; prompts and answers are not sent.

## License

MIT
