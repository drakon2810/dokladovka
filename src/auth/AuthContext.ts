import { createContext, useContext } from 'react';
import type { AuthSession, LoginCredentials, UpdateProfileInput } from './types';

export interface AuthContextValue {
  session: AuthSession | null;
  loading: boolean;
  login(credentials: LoginCredentials): Promise<AuthSession>;
  logout(): Promise<void>;
  updateProfile(input: UpdateProfileInput): Promise<AuthSession>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth musí byť použitý v AuthProvider');
  return value;
}
