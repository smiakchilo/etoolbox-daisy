import { z } from 'zod';

/**
 * Correlation identifiers for the application's contract layer.
 *
 * Every identifier is a *branded* string rather than a bare `string`. The
 * contract layer passes many same-shaped identifiers through the same call
 * sites - a tool request carries a request, chat, turn and server id at once
 * (implementation-plan.md step 03) - and nothing but a brand stops a `chatId`
 * being handed to a parameter that wanted a `turnId`. The compiler catches
 * that class of mistake; a runtime validator never could, because both values
 * are structurally identical.
 *
 * Identifier *generation* deliberately lives outside this module. `src/shared`
 * is compiled with `types: []` so it stays usable from the preload's
 * browser-facing bundle, which means no `node:crypto`; and a module that
 * reaches for an ambient global to mint ids is untestable. Callers pass an
 * {@link IdGenerator} instead.
 */

const ID_MAX_LENGTH = 200;

/**
 * Shared shape for every identifier: non-empty, bounded, and free of control
 * characters. Identifiers end up in log lines, IPC payloads, and file names,
 * so a raw newline or NUL in one is a correctness problem rather than merely
 * an odd-looking value.
 */
const identifierSchema = z
  .string()
  .min(1, 'must not be empty')
  .max(ID_MAX_LENGTH, `must be at most ${String(ID_MAX_LENGTH)} characters`)
  .refine(
    (value) => ![...value].some((char) => char.codePointAt(0)! < 0x20 || char === '\u007f'),
    'must not contain control characters',
  )
  .refine((value) => value.trim() === value, 'must not have leading or trailing whitespace');

declare const brand: unique symbol;

/** Attaches a compile-time-only tag to `string`; erased at runtime. */
type Branded<TBrand extends string> = string & { readonly [brand]: TBrand };

/** Stable identifier of a configured AEM server entry. */
export type ServerId = Branded<'ServerId'>;
/** Stable identifier of a configured proxy entry. */
export type ProxyId = Branded<'ProxyId'>;
/** Stable identifier of a conversation, owned by this application. */
export type ChatId = Branded<'ChatId'>;
/** Identifier of the Copilot SDK session backing a chat. Owned by the SDK. */
export type SdkSessionId = Branded<'SdkSessionId'>;
/** One user message and everything the agent does in response to it. */
export type TurnId = Branded<'TurnId'>;
/** A single assistant message within a turn. */
export type MessageId = Branded<'MessageId'>;
/** A single tool invocation requested by the agent. */
export type ToolCallId = Branded<'ToolCallId'>;
/** One application-issued AEM request, used end to end for correlation. */
export type RequestId = Branded<'RequestId'>;

function brandedSchema<TId extends string>(label: string): z.ZodType<TId> {
  return identifierSchema.describe(label) as unknown as z.ZodType<TId>;
}

export const serverIdSchema = brandedSchema<ServerId>('serverId');
export const proxyIdSchema = brandedSchema<ProxyId>('proxyId');
export const chatIdSchema = brandedSchema<ChatId>('chatId');
export const sdkSessionIdSchema = brandedSchema<SdkSessionId>('sdkSessionId');
export const turnIdSchema = brandedSchema<TurnId>('turnId');
export const messageIdSchema = brandedSchema<MessageId>('messageId');
export const toolCallIdSchema = brandedSchema<ToolCallId>('toolCallId');
export const requestIdSchema = brandedSchema<RequestId>('requestId');

/**
 * Supplies fresh identifiers. Production wires this to `crypto.randomUUID`;
 * tests pass a counter so sequences are reproducible.
 */
export type IdGenerator = () => string;

function mint<TId extends string>(
  schema: z.ZodType<TId>,
  generate: IdGenerator,
  label: string,
): TId {
  const parsed = schema.safeParse(generate());
  if (!parsed.success) {
    throw new Error(
      `IdGenerator produced an invalid ${label}: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
    );
  }
  return parsed.data;
}

export const newServerId = (generate: IdGenerator): ServerId =>
  mint(serverIdSchema, generate, 'serverId');
export const newProxyId = (generate: IdGenerator): ProxyId =>
  mint(proxyIdSchema, generate, 'proxyId');
export const newChatId = (generate: IdGenerator): ChatId => mint(chatIdSchema, generate, 'chatId');
export const newTurnId = (generate: IdGenerator): TurnId => mint(turnIdSchema, generate, 'turnId');
export const newMessageId = (generate: IdGenerator): MessageId =>
  mint(messageIdSchema, generate, 'messageId');
export const newToolCallId = (generate: IdGenerator): ToolCallId =>
  mint(toolCallIdSchema, generate, 'toolCallId');
export const newRequestId = (generate: IdGenerator): RequestId =>
  mint(requestIdSchema, generate, 'requestId');
