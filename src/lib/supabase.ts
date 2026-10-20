import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { anchorClock, type ServerClock } from "./time";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabase: SupabaseClient | null = url && key ? createClient(url, key) : null;

/** Server soatini o'qib, monoton soatga bog'laydi. */
export async function syncServerClock(sb: SupabaseClient): Promise<ServerClock> {
  const before = performance.now();
  const { data, error } = await sb.rpc("server_now");
  const after = performance.now();
  if (error) throw error;
  return anchorClock(data as string, before, after);
}

/** RPC chaqiruv: xato bo'lsa tashlaydi (KC:… xabari bilan). */
export async function call<T>(sb: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}
