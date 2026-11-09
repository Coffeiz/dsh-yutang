import { ApiError, listTopics } from '../../api';
import type { Topic } from '../../api';

export type TopicListOptions = { q?: string; sort?: 'hot' | 'latest'; cursor?: string; limit?: number; signal?: AbortSignal };

export async function listTopicsWithRetry(options: TopicListOptions) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await listTopics(options);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const retryable = !(error instanceof ApiError) || error.status === undefined || error.status >= 500;
      if (!retryable || attempt >= 2) throw error;
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          window.clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        };
        const timer = window.setTimeout(() => {
          options.signal?.removeEventListener('abort', onAbort);
          resolve();
        }, 250 * (attempt + 1));
        options.signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
  }
}

export function topicInitial(name: string) {
  return Array.from(name.trim())[0]?.toLocaleUpperCase() ?? '#';
}

export type { Topic };
