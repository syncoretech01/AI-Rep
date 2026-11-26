/** Domain primitives shared across modules. */

/** Communication channels. Web chat (Phase 1) and browser voice (Phase 2 proof of concept); phone comes in Phase 3. */
export const CHANNELS = ['web_chat', 'web_voice'] as const;
export type Channel = (typeof CHANNELS)[number];

export const MEMBER_ROLES = ['owner', 'admin', 'member'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export function isAdminRole(role: MemberRole): boolean {
  return role === 'owner' || role === 'admin';
}

export type DomainErrorCode = 'not_found' | 'forbidden' | 'conflict' | 'invalid';

/** Expected business-rule failure with a message that is safe to show to an admin user. */
export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}
