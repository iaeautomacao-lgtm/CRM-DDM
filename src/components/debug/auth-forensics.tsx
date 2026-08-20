"use client";

import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  logAuthFx,
  startAuthCookieForensics,
  summarizeSession,
  summarizeSupabaseCookies,
} from "@/lib/auth/auth-forensics";

export function AuthForensics() {
  useEffect(() => {
    startAuthCookieForensics();

    const supabase = createClient();
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      logAuthFx("STATE", {
        event,
        ...summarizeSession(session),
        cookies: summarizeSupabaseCookies(),
      });
    });

    void supabase.auth.getSession().then(({ data, error }) => {
      logAuthFx("SESSION-CHECK", {
        source: "AuthForensics.mount",
        error: error?.message ?? null,
        ...summarizeSession(data.session),
        cookies: summarizeSupabaseCookies(),
      });
    });

    return () => subscription.unsubscribe();
  }, []);

  return null;
}