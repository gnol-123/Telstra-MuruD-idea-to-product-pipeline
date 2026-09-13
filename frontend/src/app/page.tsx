"use client";

import { useEffect, useState } from "react";
import { loadAuth, saveAuth } from "@/lib/auth";
import { getMe } from "@/lib/api";
import { Project } from "@/lib/types";
import LoginScreen from "@/components/LoginScreen";
import ProjectsScreen from "@/components/ProjectsScreen";
import MeshCanvas from "@/components/MeshCanvas";

export default function Home() {
  const [checkedAuth, setCheckedAuth] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    // Google login (POST /auth/login/google) returns the browser here with
    // the session in the URL fragment, since only JS can read that part.
    if (window.location.hash.includes("access_token")) {
      const params = new URLSearchParams(window.location.hash.slice(1));
      const access_token = params.get("access_token");
      const refresh_token = params.get("refresh_token");
      if (access_token && refresh_token) {
        saveAuth({ access_token, refresh_token });
      }
      window.history.replaceState({}, "", window.location.pathname);
    }

    // A tool node's OAuth connect flow (POST /nodes/{id}/authorize) is
    // completed server-side and lands back here with a query param instead.
    const search = new URLSearchParams(window.location.search);
    const oauth = search.get("oauth");
    if (oauth === "connected") setNotice("Account connected — re-open the tool node to confirm it verified.");
    else if (oauth === "error") setNotice("That account connection failed. Open the tool node and try again.");
    if (oauth) window.history.replaceState({}, "", window.location.pathname);

    const stored = loadAuth();
    if (!stored) {
      setCheckedAuth(true);
      return;
    }
    // Confirm the stored token still works rather than trusting it blindly.
    getMe()
      .then(() => setLoggedIn(true))
      .catch(() => setLoggedIn(false))
      .finally(() => setCheckedAuth(true));
  }, []);

  if (!checkedAuth) {
    return <div className="h-screen flex items-center justify-center text-muted text-sm bg-bg">Loading…</div>;
  }

  const banner = notice && (
    <div className="bg-accent/10 border-b border-accent/30 text-accent text-xs px-5 py-2 flex items-center gap-3">
      <span className="flex-1">{notice}</span>
      <button onClick={() => setNotice(null)} className="text-accent/70 hover:text-accent">
        dismiss
      </button>
    </div>
  );

  if (!loggedIn) {
    return (
      <>
        {banner}
        <LoginScreen onLoggedIn={() => setLoggedIn(true)} />
      </>
    );
  }

  if (!activeProject) {
    return (
      <>
        {banner}
        <ProjectsScreen onOpen={setActiveProject} onLoggedOut={() => setLoggedIn(false)} />
      </>
    );
  }

  return (
    <>
      {banner}
      <MeshCanvas project={activeProject} onBack={() => setActiveProject(null)} />
    </>
  );
}
