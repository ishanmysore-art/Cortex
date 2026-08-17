export type AuthState = {
  error: string | null;
  success: string | null;
};

export const initialAuthState: AuthState = { error: null, success: null };
