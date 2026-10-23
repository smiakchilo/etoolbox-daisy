import { z } from 'zod';

/**
 * Saved sign-ins: the contract behind the browser pane's credential vault.
 *
 * The pane remembers a credential it saw submitted on a sign-in form and
 * prefills that origin's form on the next visit. Everything except two facts is
 * main's business, so this module carries only:
 *
 * - `credentials:captured` - the remote page's preload reports one submitted
 *   form (`{ username, password }`). *Main* decides what the origin is: it
 *   never trusts the payload for that, only the sending frame's URL - see
 *   `src/main/credentials/capture.ts`. This channel is the preload's only
 *   outbound message; it is never answered, and no command is ever sent back
 *   to the page through it.
 * - `credentials:erase` - the Settings "Browser" tab's one management action:
 *   forget every saved sign-in, all or nothing.
 *
 * A password never crosses the renderer boundary in either direction: the erase
 * names nothing at all and answers with a bare acknowledgement. That is
 * deliberate - the renderer is the shell's UI and has no reason to see a
 * credential, while the preload must, because it is where the form is. There is
 * deliberately no "how many are stored" read either: the count has no action
 * attached to it, and a number beside the erase button only invited the
 * question of why it was there.
 */
export const credentialsErrorCodeSchema = z.enum(['untrusted_sender', 'storage_error']);

export type CredentialsErrorCode = z.infer<typeof credentialsErrorCodeSchema>;

export const credentialsIpcResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.object({ code: credentialsErrorCodeSchema, message: z.string().max(500) }).strict(),
    })
    .strict(),
]);

export type CredentialsIpcResult = Readonly<z.infer<typeof credentialsIpcResultSchema>>;

export function parseCredentialsIpcResult(candidate: unknown): CredentialsIpcResult {
  return credentialsIpcResultSchema.parse(candidate);
}

/**
 * One submitted sign-in form, as the preload reads it. `username` may be empty:
 * an identity provider's password step often keeps the name in a hidden field
 * or in page state, so main fills it in from the origin's most recent entry
 * rather than discarding an otherwise usable password.
 */
export const credentialCaptureSchema = z
  .object({
    username: z.string().max(320),
    password: z.string().min(1).max(1024),
  })
  .strict();

export type CredentialCapture = Readonly<z.infer<typeof credentialCaptureSchema>>;
