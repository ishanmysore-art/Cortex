import { createClient, type SupabaseClientOptions } from "@supabase/supabase-js";

/**
 * A service-role client is for trusted background work only. It must never be
 * imported by a Client Component or exposed through a route response.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is required for background ingestion work.",
    );
  }

  /**
   * A minimal no-op that satisfies the WebSocketLikeConstructor type contract
   * so that realtime-js does not throw on Node.js < 22 (which lacks native
   * WebSocket). Background workers never subscribe to real-time channels, so
   * this stub is never actually called.
   */
  class NoopWebSocket extends EventTarget {
    static CONNECTING = 0 as const;
    static OPEN = 1 as const;
    static CLOSING = 2 as const;
    static CLOSED = 3 as const;
    readyState = NoopWebSocket.CLOSED as 0 | 1 | 2 | 3;
    bufferedAmount = 0;
    extensions = "";
    protocol = "";
    url = "";
    binaryType = "blob" as const;
    onopen = null;
    onerror = null;
    onclose = null;
    onmessage = null;
    send() {}
    close() {}
  }

  const opts: SupabaseClientOptions<never> = {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    // Provide a no-op WebSocket transport so that realtime-js does not
    // crash on Node.js < 22, which lacks native WebSocket. The admin
    // client never subscribes to real-time channels.
    realtime: { transport: NoopWebSocket as unknown as typeof WebSocket },
  };

  return createClient(url, serviceRoleKey, opts);
}
