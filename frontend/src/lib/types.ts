export type TabId =
  | "Project Idea"
  | "Market Research"
  | "Slides"
  | "UI Design"
  | "Code";

export interface ChatMessage {
  role: "agent" | "user";
  who: string;
  time: string;
  text: string;
}

export interface SourceItem {
  id: string;
  label: string;
  meta: string;
}

export interface SourceGroup {
  id: string;
  tab: TabId;
  icon: string;
  items: SourceItem[];
}

export interface CompetitorRow {
  name: string;
  segment: string;
  price: string;
  gap: string;
}

export interface FileItem {
  id: string;
  name: string;
  changed?: boolean;
}
