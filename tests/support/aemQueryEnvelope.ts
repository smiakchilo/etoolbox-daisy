import { type AemQueryRequest, aemQueryRequestSchema } from '../../src/tools/aem-query/aemQuery';
import { newChatId, newRequestId, newServerId, newTurnId } from '../../src/shared';
import { createCountingIdGenerator } from './testIds';

/** An `aem_query` request whose identifiers come from a fresh counting generator. */
export function aemQueryEnvelope(args: unknown): AemQueryRequest {
  const ids = createCountingIdGenerator('q');
  return aemQueryRequestSchema.parse({
    operation: 'aem_query',
    requestId: newRequestId(ids),
    chatId: newChatId(ids),
    turnId: newTurnId(ids),
    serverId: newServerId(ids),
    serverRevision: 1,
    navigationEpoch: 0,
    deadlineMs: 1,
    args,
  });
}
