"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { createClient } from "@/utils/supabase/client";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Pending = null | "sending" | "verifying";

export function SignInForm({ serverError }: { serverError?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(serverError ?? null);

  const emailValid = EMAIL_RE.test(email.trim());

  async function send(isCode: boolean) {
    setError(null);
    setNotice(null);
    setPending("sending");
    try {
      const supabase = createClient();
      const { error: sendError } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: {
          emailRedirectTo: `${location.origin}/auth/callback`,
        },
      });
      if (sendError) {
        setError(sendError.message);
        return;
      }
      if (isCode) {
        setCodeSent(true);
        setNotice("Code sent — check your email for a 6-digit code.");
      } else {
        setNotice("Sign-in link sent — check your email.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reach the sign-in service.");
    } finally {
      setPending(null);
    }
  }

  async function verify() {
    if (!codeSent) return;
    setError(null);
    setPending("verifying");
    try {
      const supabase = createClient();
      const { error: verifyError } = await supabase.auth.verifyOtp({
        email: email.trim(),
        token: code.trim(),
        type: "email",
      });
      if (verifyError) {
        setError(verifyError.message);
        return;
      }
      router.push("/dashboard");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reach the sign-in service.");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="mt-6 space-y-5">
      <label className="block space-y-2">
        <span className="eyebrow">Email</span>
        <input
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-lg border border-line bg-panel-2 px-3.5 py-2.5 text-sm text-white placeholder:text-dim"
        />
      </label>

      {codeSent && (
        <label className="block space-y-2">
          <span className="eyebrow">6-digit code</span>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="123456"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            className="w-full rounded-lg border border-line bg-panel-2 px-3.5 py-2.5 font-mono text-sm tracking-[0.4em] text-white placeholder:tracking-normal placeholder:text-dim"
          />
        </label>
      )}

      <div className="space-y-2.5">
        {codeSent ? (
          <button
            type="button"
            onClick={verify}
            disabled={pending !== null || code.length !== 6}
            className="w-full rounded-lg bg-gold px-4 py-2.5 text-sm font-semibold text-ink transition-colors hover:bg-gold-deep disabled:opacity-50"
          >
            {pending === "verifying" ? "Verifying…" : "Verify and sign in"}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => send(false)}
            disabled={pending !== null || !emailValid}
            className="w-full rounded-lg bg-gold px-4 py-2.5 text-sm font-semibold text-ink transition-colors hover:bg-gold-deep disabled:opacity-50"
          >
            {pending === "sending" ? "Sending…" : "Email me a sign-in link"}
          </button>
        )}
        <button
          type="button"
          onClick={() => (codeSent ? setCodeSent(false) : send(true))}
          disabled={pending !== null || (!codeSent && !emailValid)}
          className="w-full rounded-lg border border-line px-4 py-2.5 text-sm font-medium text-mist transition-colors hover:border-dim hover:text-white disabled:opacity-50"
        >
          {codeSent ? "Use a sign-in link instead" : "Send a 6-digit code instead"}
        </button>
      </div>

      {notice && <p className="text-sm text-jade">{notice}</p>}
      {error && <p className="text-sm text-[#f87171]">{error}</p>}

      <p className="text-xs text-dim">
        Passwordless — no password to forget. The link or code signs you in on
        this device.
      </p>
    </div>
  );
}
