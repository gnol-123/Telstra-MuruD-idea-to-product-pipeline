"use client";

import { useState } from "react";
import { login, signup, googleLoginUrl, ApiError } from "@/lib/api";
import { BrandMark } from "./Brand";

export default function LoginScreen({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleGoogle() {
    setError(null);
    try {
      const { url } = await googleLoginUrl(window.location.origin);
      window.location.href = url;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start Google sign-in");
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      if (mode === "login") {
        await login(email, password);
        onLoggedIn();
      } else {
        await signup(email, password);
        setMessage("Check your email to confirm your account, then log in.");
        setMode("login");
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="h-screen flex items-center justify-center bg-bg text-text"
      style={{
        backgroundImage: "radial-gradient(rgba(255,255,255,.06) 1px, transparent 1px)",
        backgroundSize: "26px 26px",
      }}
    >
      <form
        onSubmit={handleSubmit}
        className="w-[340px] bg-modal border border-accent/[0.3] rounded-2xl p-7 space-y-4 shadow-[0_40px_120px_rgba(0,0,0,.8),0_0_70px_rgba(34,224,240,.07)] anim-pop"
      >
        <div className="flex items-center gap-3 pb-1">
          <BrandMark />
          <div>
          <div className="text-sm font-semibold">Agent Mesh</div>
          <div className="text-xs text-muted">
            {mode === "login" ? "Log in to your workspace" : "Create an account"}
          </div>
          </div>
        </div>

        <input
          type="email"
          required
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full bg-white/[0.03] border border-white/[0.13] rounded-lg px-3 py-2.5 text-sm outline-none focus:border-accent/50 placeholder:text-white/30"
        />
        <input
          type="password"
          required
          minLength={8}
          placeholder="Password (min 8 chars)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full bg-white/[0.03] border border-white/[0.13] rounded-lg px-3 py-2.5 text-sm outline-none focus:border-accent/50 placeholder:text-white/30"
        />

        {error && <div className="text-xs text-red-400">{error}</div>}
        {message && <div className="text-xs text-green">{message}</div>}

        <button
          type="submit"
          disabled={busy}
          className="w-full bg-accent hover:bg-[#5eeaf6] text-[#00191d] font-semibold rounded-lg py-2.5 text-sm disabled:opacity-50"
        >
          {busy ? "Please wait…" : mode === "login" ? "Log in" : "Sign up"}
        </button>

        <button
          type="button"
          onClick={() => setMode(mode === "login" ? "signup" : "login")}
          className="w-full text-xs text-muted hover:text-text"
        >
          {mode === "login" ? "Need an account? Sign up" : "Already have one? Log in"}
        </button>

        <div className="flex items-center gap-3 text-[10px] text-muted">
          <div className="flex-1 h-px bg-border" />
          or
          <div className="flex-1 h-px bg-border" />
        </div>

        <button
          type="button"
          onClick={handleGoogle}
          className="w-full border border-white/[0.14] rounded-lg py-2.5 text-sm text-text/80 hover:border-accent/40"
        >
          Continue with Google
        </button>
      </form>
    </div>
  );
}
