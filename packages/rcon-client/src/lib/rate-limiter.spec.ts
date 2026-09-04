import { describe, expect, it } from 'vitest';
import { RateLimiter } from './rate-limiter.js';

describe('RateLimiter', () => {
  it('does not delay the first call', async () => {
    const limiter = new RateLimiter(1000);
    const start = Date.now();
    await limiter.wait();
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('delays a second call until the minimum interval has elapsed', async () => {
    const limiter = new RateLimiter(100);
    await limiter.wait();
    const start = Date.now();
    await limiter.wait();
    expect(Date.now() - start).toBeGreaterThanOrEqual(90);
  });

  it('does not delay a call made after the interval has already elapsed', async () => {
    const limiter = new RateLimiter(20);
    await limiter.wait();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const start = Date.now();
    await limiter.wait();
    expect(Date.now() - start).toBeLessThan(20);
  });
});
