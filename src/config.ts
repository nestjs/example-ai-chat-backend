import { z } from 'zod';

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().default(3000),
    DATABASE_URL: z.url(),
    // Signs the access tokens: at least 32 bytes.
    JWT_SECRET: z.string().min(32),
    // The browser origins allowed to call the API, comma-separated. None by default.
    CORS_ORIGINS: z
      .string()
      .default('')
      .transform((value) => value.split(',').map((origin) => origin.trim()).filter(Boolean))
      .pipe(z.array(z.url())),
    // An Anthropic model id, or `fake` for a scripted model that needs no API key.
    AI_MODEL: z.string().min(1).default('claude-opus-5-5'),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    // The most output tokens of one model call: an answer makes up to `maxSteps` of them.
    AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).max(8_000).default(1_000),
  })
  .superRefine((env, ctx) => {
    if (env.AI_MODEL === 'fake' && env.NODE_ENV === 'production') {
      ctx.addIssue({ code: 'custom', path: ['AI_MODEL'], message: 'The fake model is for development and tests' });
    }
    if (env.AI_MODEL !== 'fake' && !env.ANTHROPIC_API_KEY) {
      ctx.addIssue({ code: 'custom', path: ['ANTHROPIC_API_KEY'], message: `Required for the model ${env.AI_MODEL}` });
    }
  });

export type Env = z.infer<typeof envSchema>;
