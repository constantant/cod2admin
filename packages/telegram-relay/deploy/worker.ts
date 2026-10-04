// Cloudflare Workers entry point — see packages/telegram-relay/README.md.
import { handleRelayRequest } from '../src/lib/relay.ts';

export default {
  fetch: (request: Request) => handleRelayRequest(request),
};
