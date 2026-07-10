export interface JwtPayload {
  sub: string;
  email: string;
  role: 'USER' | 'ADMIN';
}

export interface AuthenticatedUser {
  userId: string;
  email: string;
  role: 'USER' | 'ADMIN';
}
