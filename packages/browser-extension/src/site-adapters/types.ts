import type { DownloadType } from "@mediago/common";

export interface PageCandidate {
  name: string;
  url: string;
  type: DownloadType;
}

export type PageCard = HTMLElement;

export type PageCardHandler = (card: PageCard) => void;

export type PageAdapterLocation = Pick<Location, "hostname">;

export interface PageAdapter {
  matches(location: PageAdapterLocation): boolean;
  observe(document: Document, onCard: PageCardHandler): () => void;
  extractCandidate(card: PageCard): PageCandidate | null;
  markProcessed(card: PageCard): void;
  clearProcessed(card: PageCard): void;
}

export type PageTransport = (candidate: PageCandidate) => void;
