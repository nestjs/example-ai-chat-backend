import { Injectable } from '@nestjs/common';
import { ThrottlerGuard, type ThrottlerRequest } from '@nestjs/throttler';

/**
 * Counts the `chat` limit per signed-in user. Bound to the chat route, it runs after the global
 * guards, authentication's included, so the user is known; the global throttler guard skips
 * `chat` (it runs before authentication), and this one counts nothing else.
 */
@Injectable()
export class ChatThrottlerGuard extends ThrottlerGuard {
  protected async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    return requestProps.throttler.name === 'chat' ? super.handleRequest(requestProps) : true;
  }
}
