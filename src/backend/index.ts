import { createLocalBackend } from './local';
import { createSupabaseBackend } from './supabase';
import type { Backend } from './types';

const env = import.meta.env;

/** null when the build was made without backend settings. */
export const backend: Backend | null = (() => {
  if (env.VITE_LOCAL_BACKEND_URL) return createLocalBackend(env.VITE_LOCAL_BACKEND_URL);
  if (env.VITE_SUPABASE_URL && env.VITE_SUPABASE_ANON_KEY) {
    return createSupabaseBackend(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY);
  }
  return null;
})();
