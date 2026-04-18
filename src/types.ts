export interface ParsedProject {
  number: number;
  ticker: string;
  name: string;
  summary: string;
  signals: string;
  potential: number | null;
  risk: number | null;
  probability: string;
  fullText: string;
}
