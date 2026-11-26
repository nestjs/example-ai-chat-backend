import { FakeModel } from '@nestjs/ai/testing';

/**
 * A scripted model, for development without an API key: it searches the notes for the last word
 * of the question, with the real search-notes tool, then streams the titles it found.
 */
export function createFakeModel() {
  return new FakeModel((call) => {
    if (call.toolResults.length === 0) {
      const words = call.lastUserMessage?.match(/[\p{L}\p{N}]+/gu) ?? ['note'];
      return { toolCalls: [{ name: 'search-notes', input: { query: words[words.length - 1] } }] };
    }
    const found = call.toolResults[0].output;
    if (!Array.isArray(found)) {
      return `The search failed: ${String(found)}`;
    }
    const titles = found.map((note: { title: string }) => `"${note.title}"`).join(', ');
    const text = found.length === 0 ? 'None of your notes mention that.' : `Your notes mention it in ${titles}.`;
    return { text, chunkDelay: 40 };
  });
}
