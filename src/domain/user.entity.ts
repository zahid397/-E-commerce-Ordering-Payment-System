export type UserRoleValue = 'USER' | 'ADMIN';

export interface UserProps {
  id: string;
  email: string;
  role: UserRoleValue;
}

/**
 * Domain entity for User. Deliberately thin — most of User's "logic" in
 * this system is authentication/authorization, which is cross-cutting
 * infrastructure (guards, JWT strategy) rather than a domain rule, so it
 * doesn't belong here. What *does* belong here is kept: the one business
 * question the rest of the app repeatedly asks about a user.
 */
export class UserEntity {
  readonly id: string;
  readonly email: string;
  readonly role: UserRoleValue;

  constructor(props: UserProps) {
    this.id = props.id;
    this.email = props.email;
    this.role = props.role;
  }

  isAdmin(): boolean {
    return this.role === 'ADMIN';
  }

  /** Can this user view/act on an order owned by `ownerId`? */
  canAccessOrder(ownerId: string): boolean {
    return this.isAdmin() || this.id === ownerId;
  }
}
