export interface EmbeddingProvider {
  embed(text: string): Promise<number[] | null>;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  async embed(text: string): Promise<number[] | null> {
    if (!process.env.OPENAI_API_KEY || !text.trim()) return null;
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small",
        input: text,
        encoding_format: "float",
      }),
    });
    if (!response.ok) {
      throw new Error(`Embedding request failed with ${response.status}`);
    }
    const payload = await response.json() as { data?: Array<{ embedding?: number[] }> };
    return payload.data?.[0]?.embedding ?? null;
  }
}

export class NullEmbeddingProvider implements EmbeddingProvider {
  async embed(): Promise<null> { return null; }
}
