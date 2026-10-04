// Deno Deploy entry point — see packages/telegram-relay/README.md.
import { handleRelayRequest } from '../src/lib/relay.ts';

Deno.serve((request) => handleRelayRequest(request));
