import { Pinecone } from '@pinecone-database/pinecone';

let pineconeClient: Pinecone | null = null;
let indexName: string = '';

export interface PineconeConfig {
  apiKey: string;
  indexName: string;
}

export interface EmbeddingResult {
  id: string;
  values: number[];
  metadata: Record<string, any>;
}

export interface QueryResult {
  id: string;
  score: number;
  metadata: Record<string, any>;
}

async function initializePinecone(): Promise<Pinecone> {
  if (pineconeClient) {
    return pineconeClient;
  }

  const apiKey = import.meta.env.VITE_PINECONE_API_KEY;
  indexName = import.meta.env.VITE_PINECONE_INDEX_NAME || 'company-documents';

  if (!apiKey) {
    throw new Error('Pinecone API key not found in environment variables');
  }

  pineconeClient = new Pinecone({
    apiKey: apiKey,
  });

  return pineconeClient;
}

async function generateEmbedding(text: string): Promise<number[]> {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error('Gemini API key not found. Please add VITE_GEMINI_API_KEY to your .env file');
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'models/text-embedding-004',
          content: {
            parts: [{ text: text }]
          }
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.statusText}`);
    }

    const data = await response.json();
    return data.embedding.values;
  } catch (error) {
    console.error('Error generating embedding:', error);
    throw error;
  }
}

export async function upsertDocuments(
  companyId: string,
  documents: Array<{
    id: string;
    text: string;
    metadata: Record<string, any>;
  }>
): Promise<void> {
  try {
    const pc = await initializePinecone();
    const index = pc.index(indexName);

    const vectors = await Promise.all(
      documents.map(async (doc) => {
        const embedding = await generateEmbedding(doc.text);
        return {
          id: doc.id,
          values: embedding,
          metadata: {
            ...doc.metadata,
            companyId: companyId,
            text: doc.text.substring(0, 1000),
          },
        };
      })
    );

    await index.upsert(vectors);
    console.log(`Successfully upserted ${vectors.length} documents to Pinecone`);
  } catch (error) {
    console.error('Error upserting documents to Pinecone:', error);
    throw error;
  }
}

export async function queryDocuments(
  companyId: string,
  query: string,
  topK: number = 5
): Promise<Array<{ text: string; score: number; metadata: Record<string, any> }>> {
  try {
    const pc = await initializePinecone();
    const index = pc.index(indexName);

    const queryEmbedding = await generateEmbedding(query);

    const queryResponse = await index.query({
      vector: queryEmbedding,
      topK: topK,
      includeMetadata: true,
      filter: {
        companyId: { $eq: companyId }
      }
    });

    return queryResponse.matches.map((match) => ({
      text: (match.metadata?.text as string) || '',
      score: match.score || 0,
      metadata: match.metadata as Record<string, any> || {},
    }));
  } catch (error) {
    console.error('Error querying documents from Pinecone:', error);
    return [];
  }
}

export async function deleteDocuments(companyId: string, ids: string[]): Promise<void> {
  try {
    const pc = await initializePinecone();
    const index = pc.index(indexName);

    await index.deleteMany(ids);
    console.log(`Successfully deleted ${ids.length} documents from Pinecone`);
  } catch (error) {
    console.error('Error deleting documents from Pinecone:', error);
    throw error;
  }
}

export async function deleteAllCompanyDocuments(companyId: string): Promise<void> {
  try {
    const pc = await initializePinecone();
    const index = pc.index(indexName);

    await index.deleteMany({
      filter: {
        companyId: { $eq: companyId }
      }
    });
    console.log(`Successfully deleted all documents for company ${companyId}`);
  } catch (error) {
    console.error('Error deleting company documents from Pinecone:', error);
    throw error;
  }
}
