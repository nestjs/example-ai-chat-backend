import { fileURLToPath } from 'node:url';
import { PasswordHasher } from '@nestjs/authentication';
import { FakeModel, overrideModels, providerError } from '@nestjs/ai/testing';
import { getDrizzleToken } from '@nestjs/drizzle';
import { NodeAdapter, type NestNodeApplication } from '@nestjs/platform-node';
import { Test } from '@nestjs/testing';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module.js';
import { conversations } from '../src/database/schema.js';

// A real PostgreSQL with a pool, so two messages sent at once really race.
const url = process.env.TEST_DATABASE_URL;

type Chunk = { type: string; [key: string]: any };

describe.skipIf(!url)('Chat API (e2e)', () => {
  const db = drizzle({ client: new Pool({ connectionString: url, max: 10 }) });
  const model = new FakeModel();
  let app: NestNodeApplication;
  let baseUrl: string;

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
    await db.execute(sql`TRUNCATE users, refresh_tokens CASCADE`);
    const moduleRef = await overrideModels(Test.createTestingModule({ imports: [AppModule] }), { default: model })
      .overrideProvider(getDrizzleToken())
      .useValue(db)
      // scrypt at the default cost takes 128 MiB and a few hundred ms per hash.
      .overrideProvider(PasswordHasher)
      .useValue(new PasswordHasher({ logN: 10 }))
      .compile();
    app = moduleRef.createNestApplication<NestNodeApplication>(new NodeAdapter());
    // A real server: the tests read the answer chunk by chunk, and hang up mid-answer.
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(() => app.close()); // closes the pool too

  let clients = 0;

  /** Signs a user up, with a note, and returns the headers that authenticate as them. */
  async function signUp(email: string, note = { title: 'Buy milk', body: 'Oat milk, 2 litres' }) {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/sign-up',
      payload: { email, password: 'correct horse battery' },
      // Sign-up is rate-limited per IP address: each user signs up from their own.
      remoteAddress: `10.0.0.${++clients}`,
    });
    const headers = { authorization: `Bearer ${res.json<{ accessToken: string }>().accessToken}` };
    const created = await app.inject({ method: 'POST', url: '/notes', headers, payload: note });
    return { headers, noteId: created.json<{ id: string }>().id };
  }

  async function startConversation(headers: Record<string, string>) {
    const res = await app.inject({ method: 'POST', url: '/conversations', headers, payload: {} });
    return res.json<{ id: string }>().id;
  }

  function send(headers: Record<string, string>, conversationId: string, text: string, signal?: AbortSignal) {
    return fetch(`${baseUrl}/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal,
    });
  }

  /** The server-sent events of a response, as UI message chunks, read as they arrive. */
  async function* events(response: Response): AsyncGenerator<Chunk> {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const bytes of response.body!) {
      buffer += decoder.decode(bytes, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (event.startsWith('data: {')) {
          yield JSON.parse(event.slice('data: '.length));
        }
      }
    }
  }

  async function readAll(response: Response) {
    const chunks: Chunk[] = [];
    for await (const chunk of events(response)) {
      chunks.push(chunk);
    }
    return chunks;
  }

  const textOf = (chunks: Chunk[]) =>
    chunks
      .filter((chunk) => chunk.type === 'text-delta')
      .map((chunk) => chunk.delta)
      .join('');

  it("answers from the user's own notes, and saves the turn", async () => {
    const ada = await signUp('ada@example.com');
    await signUp('bob@example.com', { title: 'Milk for the cat', body: "Bob's note" });
    const conversationId = await startConversation(ada.headers);
    model.reply({ toolCalls: [{ name: 'search-notes', input: { query: 'milk' } }] }, (call) => {
      const notes = call.toolResults[0].output as Array<{ title: string }>;
      return `You have ${notes.length} note: ${notes[0].title}.`;
    });

    const response = await send(ada.headers, conversationId, 'What did I write about milk?');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const chunks = await readAll(response);

    // Bob's note matches too, and the tool never saw it.
    const output = chunks.find((chunk) => chunk.type === 'tool-output-available')?.output;
    expect(output).toEqual([expect.objectContaining({ title: 'Buy milk' })]);
    expect(textOf(chunks)).toBe('You have 1 note: Buy milk.');
    expect(model.lastCall?.options.maxOutputTokens).toBe(1000);

    // The stream ended once the turn was saved: a message sent right away gets the history.
    model.reply('Anything else?');
    const next = await send(ada.headers, conversationId, 'Thanks!');
    expect(next.status).toBe(200);
    await readAll(next);
    expect(model.lastCall?.options.prompt.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'assistant',
      'user',
    ]);
  });

  it('runs the tools as the signed-in user only', async () => {
    const carol = await signUp('carol@example.com');
    const dave = await signUp('dave@example.com', { title: "Dave's diary", body: 'Private' });
    const conversationId = await startConversation(carol.headers);
    model.reply(
      { toolCalls: [{ name: 'read-note', input: { noteId: dave.noteId } }] },
      { toolCalls: [{ name: 'create-note', input: { title: 'Call mum' } }] },
      'Saved.',
    );

    await readAll(await send(carol.headers, conversationId, `Read note ${dave.noteId}, then remind me to call mum`));

    // Dave's note is as missing as one that doesn't exist.
    expect(model.calls.at(-2)?.toolResults).toEqual([
      expect.objectContaining({ toolName: 'read-note', output: 'Note not found' }),
    ]);
    const notes = await app.inject({ method: 'GET', url: '/notes', headers: carol.headers });
    expect(notes.json().map((note: { title: string }) => note.title)).toEqual(['Call mum', 'Buy milk']);
  });

  it('streams the answer as the model writes it', async () => {
    const { headers } = await signUp('erin@example.com');
    const conversationId = await startConversation(headers);
    model.reply({ text: 'One two three four five', chunkDelay: 100 });

    const arrivals: number[] = [];
    for await (const chunk of events(await send(headers, conversationId, 'Count to five'))) {
      if (chunk.type === 'text-delta') {
        arrivals.push(performance.now());
      }
    }

    expect(arrivals).toHaveLength(5);
    // Each word arrived on its own, about 100 ms after the one before.
    expect(arrivals[4] - arrivals[0]).toBeGreaterThan(300);
  });

  it('aborts the model call when the client goes away', async () => {
    const { headers } = await signUp('frank@example.com');
    const conversationId = await startConversation(headers);
    model.reply({ text: 'A long answer that nobody reads to its end', chunkDelay: 200 });
    const client = new AbortController();

    const response = await send(headers, conversationId, 'Tell me a long story', client.signal);
    for await (const chunk of events(response)) {
      if (chunk.type === 'text-delta') {
        break;
      }
    }
    client.abort(); // the browser tab closes
    await vi.waitFor(() => expect(model.lastCall?.options.abortSignal?.aborted).toBe(true));

    // Nothing of the turn was kept, and the conversation takes the next message.
    await vi.waitFor(async () => {
      const saved = await app.inject({ method: 'GET', url: `/conversations/${conversationId}`, headers });
      expect(saved.json()).toMatchObject({ answeringUntil: null, messages: [] });
    });
    model.reply('Here is a shorter one.');
    const next = await send(headers, conversationId, 'A shorter one, then');
    expect(textOf(await readAll(next))).toBe('Here is a shorter one.');
  });

  it('answers one message at a time per conversation', async () => {
    const { headers } = await signUp('grace@example.com');
    const conversationId = await startConversation(headers);
    // One answer: only one of the messages reaches the model.
    model.reply({ text: 'First', delay: 200 });

    // Open the pool's connections first, so no request waits for one: they all race.
    await Promise.all(Array.from({ length: 10 }, () => db.execute(sql`select pg_sleep(0.05)`)));
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        app.inject({ method: 'POST', url: `/conversations/${conversationId}/messages`, headers, payload: { text: 'Hi' } }),
      ),
    );

    expect(responses.map((res) => res.statusCode).sort()).toEqual([200, ...Array(9).fill(409)]);

    // A claim left behind by a process that died, past its time, is taken over.
    await db
      .update(conversations)
      .set({ answeringUntil: new Date(Date.now() - 1_000) })
      .where(eq(conversations.id, conversationId));
    model.reply('Back.');
    expect(textOf(await readAll(await send(headers, conversationId, 'Still there?')))).toBe('Back.');
  });

  it('sends the model the latest history that fits the budget, from a question', async () => {
    // Every search returns this note: about 2,500 tokens per turn.
    const { headers } = await signUp('heidi@example.com', { title: 'Long', body: 'x'.repeat(10_000) });
    const conversationId = await startConversation(headers);
    for (let turn = 1; turn <= 4; turn++) {
      model.reply({ toolCalls: [{ name: 'search-notes', input: { query: 'long' } }] }, 'Found it.');
      await readAll(await send(headers, conversationId, `Question ${turn}`));
    }
    model.reply('Done.');

    await readAll(await send(headers, conversationId, 'Question 5'));

    const prompt = model.lastCall!.options.prompt;
    // The first turn didn't fit, and the history starts at a question, never at a tool result.
    expect(prompt[1].role).toBe('user');
    const questions = prompt.filter((message) => message.role === 'user').map((message) => message.content);
    expect(JSON.stringify(questions)).not.toContain('Question 1');
    expect(JSON.stringify(questions)).toContain('Question 2');
  });

  it('retries an overloaded provider, and tells the user when it fails', async () => {
    const { headers } = await signUp('ivan@example.com');
    const conversationId = await startConversation(headers);
    const unavailable = { type: 'error', errorText: 'The assistant is unavailable. Try again in a minute.' };
    // Overloaded, then answers: retried.
    model.reply(providerError(529), 'Back again.');
    expect(textOf(await readAll(await send(headers, conversationId, 'Hello?')))).toBe('Back again.');

    // A revoked API key: not retried, and the stream says so.
    model.reply(providerError(401, { message: 'Invalid API key' }));
    const refused = await send(headers, conversationId, 'Are you there?');
    expect(refused.status).toBe(200);
    expect(await readAll(refused)).toContainEqual(unavailable);

    // A stream that breaks after its first words ends with the same error.
    model.reply({ text: 'Your notes say', streamError: providerError(500) });
    const broken = await readAll(await send(headers, conversationId, 'What do my notes say?'));
    expect(textOf(broken)).toBe('Your notes say');
    expect(broken.at(-1)).toEqual(unavailable);

    // Only the answered turn was kept.
    const saved = await app.inject({ method: 'GET', url: `/conversations/${conversationId}`, headers });
    expect(saved.json()).toMatchObject({ answeringUntil: null });
    expect(saved.json().messages).toHaveLength(2);
  });

  it('limits how many messages each user sends', async () => {
    const { headers } = await signUp('ken@example.com');
    const conversationId = await startConversation(headers);
    model.reply(...Array.from({ length: 30 }, () => 'OK.'));
    for (let i = 0; i < 30; i++) {
      await readAll(await send(headers, conversationId, `Message ${i}`));
    }

    const limited = await send(headers, conversationId, 'One more');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after-chat')).toBeTruthy();

    // Another user isn't limited by Ken's messages.
    const other = await signUp('lena@example.com');
    model.reply('Hi Lena.');
    expect((await send(other.headers, await startConversation(other.headers), 'Hi')).status).toBe(200);
  });
});
