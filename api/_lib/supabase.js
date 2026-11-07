import { createClient } from '@supabase/supabase-js';

// SERVER ONLY. Uses the service-role key, which bypasses RLS. Never import this in src/.
export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);
