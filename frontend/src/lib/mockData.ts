import { TabId, ChatMessage, SourceGroup, CompetitorRow, FileItem } from "./types";

export const TABS: TabId[] = [
  "Project Idea",
  "Market Research",
  "Slides",
  "UI Design",
  "Code",
];

export const AGENT_NAME: Record<TabId, string> = {
  "Project Idea": "Strategy Agent",
  "Market Research": "Research Agent",
  Slides: "Narrative Agent",
  "UI Design": "Design Agent",
  Code: "Build Agent",
};

export const PROMPT_PLACEHOLDER: Record<TabId, string> = {
  "Project Idea": "Ask Strategy Agent to sharpen the brief…",
  "Market Research": "Ask Research Agent to dig into a competitor…",
  Slides: "Ask Narrative Agent to rewrite a slide…",
  "UI Design": "Ask Design Agent to design, code, or revise…",
  Code: "Ask Build Agent to scaffold or refactor…",
};

export const CANVAS_TITLE: Record<TabId, [string, string]> = {
  "Project Idea": ["Idea Brief", "LIVE DOC"],
  "Market Research": ["Research Board", "SYNTHESIS"],
  Slides: ["Investor Deck", "14 SLIDES"],
  "UI Design": ["Visual Design Canvas", "PREVIEW"],
  Code: ["Source", "MAIN · 2 CHANGED"],
};
/* FAKE PLACE HOLDER DATA*/
export const THREADS: Record<TabId, ChatMessage[]> = {
  "Project Idea": [
    {
      role: "agent",
      who: "Strategy Agent",
      time: "09:12 AM",
      text: "Hello how can i help you?",
    },
    {
      role: "user",
      who: "You",
      time: "09:14 AM",
      text: "hi",
    },
    {
      role: "agent",
      who: "Strategy Agent",
      time: "09:14 AM",
      text: "",
    },
  ],
  "Market Research": [
    {
      role: "agent",
      who: "Research Agent",
      time: "10:02 AM",
      text: "Hello how can i help you?",
    },
    {
      role: "user",
      who: "You",
      time: "10:06 AM",
      text: "Which competitors already solve that, and how badly?",
    },
    {
      role: "agent",
      who: "Research Agent",
      time: "10:07 AM",
      text: "Matrix is on the board, sorted by overlap. Nobody scopes context per-artefact — they attach whole workspaces.",
    },
  ],
  Slides: [
    {
      role: "agent",
      who: "Narrative Agent",
      time: "10:40 AM",
      text: "Hello how can i help you?",
    },
    {
      role: "user",
      who: "You",
      time: "10:44 AM",
      text: "Rewrite the market slide using the sizing from research.",
    },
  ],
  "UI Design": [
    {
      role: "agent",
      who: "Design Agent",
      time: "11:42 AM",
      text: "Hello how can i help you?",
    },
    {
      role: "user",
      who: "You",
      time: "11:43 AM",
      text: "Generate a modern analytics dashboard layout using a clean dark grid.",
    },
  ],
  Code: [
    {
      role: "agent",
      who: "Build Agent",
      time: "12:05 PM",
      text: "Hello how can i help you?",
    },
    {
      role: "user",
      who: "You",
      time: "12:08 PM",
      text: "Pull the KPI values from the metrics module rather than hardcoding them.",
    },
  ],
};

export const SOURCES: SourceGroup[] = [
  {
    id: "idea",
    tab: "Project Idea",
    icon: "◇",
    items: [
      { id: "idea.brief", label: "One-line brief & problem statement", meta: "updated 2d ago" },
      { id: "idea.persona", label: "Target persona notes", meta: "updated 5d ago" },
    ],
  },
  {
    id: "research",
    tab: "Market Research",
    icon: "◈",
    items: [
      { id: "research.comp", label: "Competitor matrix", meta: "updated 4h ago" },
      { id: "research.tam", label: "Market sizing", meta: "updated 1d ago" },
    ],
  },
  {
    id: "slides",
    tab: "Slides",
    icon: "▤",
    items: [{ id: "slides.deck", label: "Investor deck — 14 slides", meta: "updated 1h ago" }],
  },
  {
    id: "ui",
    tab: "UI Design",
    icon: "◫",
    items: [{ id: "ui.artboard", label: "Analytics dashboard artboard", meta: "updated 12m ago" }],
  },
  {
    id: "code",
    tab: "Code",
    icon: "⌗",
    items: [{ id: "code.comp", label: "components/ (6 files)", meta: "main branch" }],
  },
];

export const COMPETITORS: CompetitorRow[] = [
  { name: "Notion AI", segment: "General docs", price: "$10/seat", gap: "No per-artefact context scoping" },
  { name: "Linear", segment: "Dev workflow", price: "$8/seat", gap: "No idea-to-prototype pipeline" },
  { name: "v0 by Vercel", segment: "UI generation", price: "$20/mo", gap: "UI only, no research or slides" },
];

export const FILES: FileItem[] = [
  { id: "tokens", name: "design-tokens.ts", changed: true },
  { id: "dash", name: "AnalyticsDashboard.tsx", changed: true },
  { id: "stat", name: "StatCard.tsx" },
  { id: "metrics", name: "lib/metrics.ts" },
];

export const CODE_SAMPLE = `import { tokens } from "./design-tokens"
import { useMetrics } from "./lib/metrics"

export default function AnalyticsDashboard() {
  const kpis = useMetrics(["sessions", "instances", "errors"])
  return (
    <div className="grid grid-cols-3 gap-4">
      {kpis.map(k => <StatCard key={k.id} {...k} />)}
    </div>
  )
}`;
