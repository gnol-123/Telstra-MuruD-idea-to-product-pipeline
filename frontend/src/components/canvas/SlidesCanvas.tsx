"use client";

import { useState } from "react";

const SLIDES = [
  { title: "Sidekick", body: "One workspace where an idea becomes a shipped product." },
  { title: "The problem", body: "Teams re-explain themselves all day. Context lives in five tools." },
  { title: "Market size", body: "A $4.8B serviceable market, built bottom-up." },
  { title: "Traction", body: "412 teams in eight weeks. 62% weekly active." },
  { title: "The ask", body: "Raising $3.5M to reach 5,000 paying teams." },
];

export default function SlidesCanvas() {
  const [i, setI] = useState(0);
  const slide = SLIDES[i];

  return (
    <div className="max-w-2xl">
      <div className="aspect-video bg-panel2 border border-border rounded-lg flex flex-col justify-center px-10">
        <div className="text-xs text-accent mb-2">Slide {i + 1} of {SLIDES.length}</div>
        <h2 className="text-xl font-semibold mb-2">{slide.title}</h2>
        <p className="text-sm text-muted">{slide.body}</p>
      </div>
      <div className="flex items-center justify-between mt-3 text-sm">
        <button
          onClick={() => setI((n) => Math.max(0, n - 1))}
          className="text-muted hover:text-text"
        >
          ← Prev
        </button>
        <span className="text-xs text-muted">16:9 · 1920×1080</span>
        <button
          onClick={() => setI((n) => Math.min(SLIDES.length - 1, n + 1))}
          className="text-muted hover:text-text"
        >
          Next →
        </button>
      </div>
    </div>
  );
}
