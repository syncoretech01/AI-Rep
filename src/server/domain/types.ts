/** Domain primitives shared across modules. */

/** Communication channels. Phase 1 ships web chat only; voice/phone are added by later phases. */
export const CHANNELS = ['web_chat'] as const;
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
