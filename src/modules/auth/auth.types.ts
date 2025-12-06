/**
 * Authentication types
 */

export interface AuthUser {
    id: string;
    email?: string;
    name?: string;
    roles?: string[];
}

export interface AuthResult {
    authenticated: boolean;
    user: AuthUser | null;
}
