import { RequestContext, RetrievedEvidence } from "../contracts";
import { searchDriveFiles } from "../drive";
import { searchGmailMessages } from "../gmail";
import { MemoryStore } from "../memory/store";
import { EmbeddingProvider } from "./embeddings";

export interface RetrieveContextInput extends RequestContext {
  query: string;
  asOf?: string;
  limit?: number;
  includeDrive?: boolean;
  includeGmail?: boolean;
}

export class KnowledgeRetrievalService {
  constructor(
    private readonly store: MemoryStore,
    private readonly embeddings: EmbeddingProvider,
  ) {}

  async retrieveContext(input: RetrieveContextInput): Promise<RetrievedEvidence[]> {
    const query = input.query.trim();
    if (!query) throw new Error("INVALID_QUERY");
    const limit = Math.min(Math.max(input.limit ?? 5, 1), 10);
    const queryEmbedding = await this.embeddings.embed(query);
    const memories = await this.store.retrieve({
      ...input,
      query,
      queryEmbedding,
      asOf: input.asOf ?? new Date().toISOString(),
      limit,
    });

    if (!input.includeDrive && !input.includeGmail) return memories;
    const external: RetrievedEvidence[] = [];

    if (input.includeDrive) {
      try {
        const files = await searchDriveFiles(query);
        external.push(...files.slice(0, 3).map((file, index): RetrievedEvidence => ({
          memory: {
            id: `drive:${file.id}`,
            content: file.name,
            summary: `Google Drive: ${file.name}`,
            status: "accessible",
            confidence: 1,
            importance: 0.5,
            validFrom: file.createdTime,
            validUntil: null,
          },
          source: {
            id: `drive-source:${file.id}`,
            type: "google_drive",
            sourceId: file.id ?? "unknown",
            meetingId: null,
            transcriptSegmentId: null,
            documentUri: file.webViewLink,
          },
          observedAt: file.modifiedTime ?? file.createdTime ?? new Date().toISOString(),
          quotedText: file.name,
          relationsUsed: [],
          score: Math.max(0.5, 0.9 - index * 0.1),
        })));
      } catch (error) {
        if (!(error as Error).message.includes("not connected")) throw error;
      }
    }

    if (input.includeGmail) {
      try {
        const messages = await searchGmailMessages(query);
        external.push(...messages.slice(0, 3).map((message, index): RetrievedEvidence => ({
          memory: {
            id: `gmail:${message.id}`,
            content: message.subject || "(sin asunto)",
            summary: `Gmail — ${message.from}: ${message.snippet}`,
            status: "accessible",
            confidence: 1,
            importance: 0.5,
            validFrom: message.date,
            validUntil: null,
          },
          source: {
            id: `gmail-source:${message.id}`,
            type: "gmail",
            sourceId: message.id,
            meetingId: null,
            transcriptSegmentId: null,
            documentUri: message.webViewLink,
          },
          observedAt: message.date || new Date().toISOString(),
          quotedText: message.snippet,
          relationsUsed: [],
          score: Math.max(0.5, 0.9 - index * 0.1),
        })));
      } catch (error) {
        if (!(error as Error).message.includes("not connected")) throw error;
      }
    }

    return [...memories, ...external].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async getMemoryNeighborhood(input: RequestContext & { memoryId: string; maxDepth?: number }): Promise<RetrievedEvidence[]> {
    if ((input.maxDepth ?? 1) > 1) throw new Error("MAX_DEPTH_EXCEEDED");
    return this.retrieveContext({ ...input, query: input.memoryId, limit: 10 });
  }

  async getCurrentCommitments(input: RequestContext & { asOf?: string }): Promise<RetrievedEvidence[]> {
    return this.retrieveContext({ ...input, query: "commitment compromiso responsable fecha", asOf: input.asOf, limit: 10 });
  }
}
