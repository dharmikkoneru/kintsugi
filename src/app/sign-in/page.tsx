import type { Metadata } from "next";

import { getSessionUser } from "@/lib/auth";

import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = {
  title: "Sign in · Kintsugi",
  description: "Sign in to your Kintsugi habit tracker.",
};

const ERRORS: Record<string, string> = {
  link: "That sign-in link expired or was already used. Send a new one.",
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const [user, params] = await Promise.all([getSessionUser(), searchParams]);

  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col justify-center px-6 py-16">
      <div className="rounded-2xl border border-line bg-panel p-8">
        <p className="eyebrow">Kintsugi</p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">
          Repair your habits with gold
        </h1>

        {user ? (
          <div className="mt-6 space-y-4">
            <p className="text-sm text-mist">
              Signed in as <span className="text-gold">{user.email}</span>.
              Head to the dashboard to keep logging.
            </p>
            <a
              href="/dashboard"
              className="block rounded-lg bg-gold px-4 py-2.5 text-center text-sm font-semibold text-ink transition-colors hover:bg-gold-deep"
            >
              Open the dashboard
            </a>
          </div>
        ) : (
          <SignInForm
            serverError={
              params.error ? ERRORS[params.error] ?? ERRORS.link : undefined
            }
          />
        )}
      </div>
    </main>
  );
}
