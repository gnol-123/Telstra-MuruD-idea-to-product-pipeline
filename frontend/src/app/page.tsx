"use client";

import { useEffect, useState } from "react";
import { loadAuth } from "@/lib/auth";
import { getMe } from "@/lib/api";
import { Project } from "@/lib/types";
import LoginScreen from "@/components/LoginScreen";
import ProjectsScreen from "@/components/ProjectsScreen";
import MeshCanvas from "@/components/MeshCanvas";

export default function Home() {
  const [checkedAuth, setCheckedAuth] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);
  const [activeProject, setActiveProject] = useState<Project | null>(null);

  useEffect(() => {
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

  if (!loggedIn) {
    return <LoginScreen onLoggedIn={() => setLoggedIn(true)} />;
  }

  if (!activeProject) {
    return (
      <ProjectsScreen
        onOpen={setActiveProject}
        onLoggedOut={() => setLoggedIn(false)}
      />
    );
  }

  return <MeshCanvas project={activeProject} onBack={() => setActiveProject(null)} />;
}
