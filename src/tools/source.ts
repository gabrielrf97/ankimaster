/**
 * Source-to-cards pipeline tools.
 *
 * Enables LLMs to create flashcards with source attribution so cards
 * are traceable back to their origin (Notion pages, Obsidian notes, PDFs, URLs).
 *
 * Uses Anki's native tag system — works with any note type.
 * Tags: ankimaster, source:{type}, source_id:{hash}, source_title:{slug}
 */

import type { AnkiClient } from "../anki-client.js";

// ── Tool Schemas ──

export const sourceToolSchemas = [
  {
    name: "create_source_cards",
    description:
      "Create flashcards with source attribution. Tags each card with its origin (Notion, Obsidian, PDF, URL, etc.) for traceability. Use get_source_cards first to check what already exists from a source.",
    inputSchema: {
      type: "object" as const,
      properties: {
        source: {
          type: "object",
          description: "Source metadata",
          properties: {
            url: {
              type: "string",
              description:
                "Source URL or path (e.g. notion page URL, obsidian file path, PDF path)",
            },
            type: {
              type: "string",
              enum: ["notion", "obsidian", "pdf", "url", "manual"],
              description: "Source type",
            },
            title: {
              type: "string",
              description: "Human-readable source title",
            },
          },
          required: ["url", "type", "title"],
        },
        notes: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              type: { type: "string", description: "Note type (e.g. Basic, Cloze)" },
              deck: { type: "string", description: "Target deck" },
              fields: {
                type: "object",
                additionalProperties: { type: "string" },
                description: "Note fields",
              },
              tags: {
                type: "array",
                items: { type: "string" },
                description: "Additional tags (source tags are added automatically)",
              },
            },
            required: ["type", "deck", "fields"],
          },
        },
      },
      required: ["source", "notes"],
    },
  },
  {
    name: "get_source_cards",
    description:
      "Find all cards created from a specific source. Use this before create_source_cards to avoid duplicates.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sourceUrl: {
          type: "string",
          description: "Source URL or path to look up",
        },
        sourceType: {
          type: "string",
          enum: ["notion", "obsidian", "pdf", "url", "manual"],
          description: "Filter by source type (optional)",
        },
      },
      required: [],
    },
  },
];

// ── Tool Handlers ──

export async function handleSourceTool(
  name: string,
  args: Record<string, unknown>,
  anki: AnkiClient
): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  switch (name) {
    case "create_source_cards":
      return createSourceCards(anki, args);
    case "get_source_cards":
      return getSourceCards(anki, args);
    default:
      throw new Error(`Unknown source tool: ${name}`);
  }
}

// ── Implementations ──

async function createSourceCards(
  anki: AnkiClient,
  args: Record<string, unknown>
) {
  const source = args.source as {
    url: string;
    type: string;
    title: string;
  };
  const notes = args.notes as {
    type: string;
    deck: string;
    fields: Record<string, string>;
    tags?: string[];
  }[];

  if (!source?.url || !source?.type || !source?.title) {
    throw new Error("source.url, source.type, and source.title are required");
  }
  if (!notes?.length) {
    throw new Error("notes array is required");
  }

  const sourceId = hashSource(source.url);
  const sourceTags = [
    "ankimaster",
    `source:${source.type}`,
    `source_id:${sourceId}`,
    `source_title:${slugify(source.title)}`,
  ];

  // Ensure all decks exist and normalize fields (with caching)
  const deckCache = new Set(await anki.deckNames());
  const fieldCache = new Map<string, string[]>();
  const prepared: {
    deckName: string;
    modelName: string;
    fields: Record<string, string>;
    tags: string[];
  }[] = [];

  for (const note of notes) {
    if (!deckCache.has(note.deck)) {
      await anki.createDeck(note.deck);
      deckCache.add(note.deck);
    }
    if (!fieldCache.has(note.type)) {
      fieldCache.set(note.type, await anki.modelFieldNames(note.type));
    }
    const modelFields = fieldCache.get(note.type)!;
    const normalized: Record<string, string> = {};
    for (const field of modelFields) {
      normalized[field] =
        note.fields[field] ?? note.fields[field.toLowerCase()] ?? "";
    }
    prepared.push({
      deckName: note.deck,
      modelName: note.type,
      fields: normalized,
      tags: [...sourceTags, ...(note.tags ?? [])],
    });
  }

  const noteIds = await anki.addNotes(prepared);

  const results = noteIds.map((id, i) => ({
    success: id !== null,
    noteId: id,
    index: i,
    ...(id === null ? { error: "Failed to create (duplicate or invalid)" } : {}),
  }));

  return json({
    source: {
      url: source.url,
      type: source.type,
      title: source.title,
      id: sourceId,
    },
    results,
    total: notes.length,
    successful: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
  });
}

async function getSourceCards(
  anki: AnkiClient,
  args: Record<string, unknown>
) {
  const sourceUrl = args.sourceUrl as string | undefined;
  const sourceType = args.sourceType as string | undefined;

  let query: string;
  if (sourceUrl) {
    const sourceId = hashSource(sourceUrl);
    query = `tag:source_id:${sourceId}`;
  } else if (sourceType) {
    query = `tag:source:${sourceType}`;
  } else {
    query = "tag:ankimaster";
  }

  const noteIds = await anki.findNotes(query);
  const limit = Math.min(noteIds.length, 50);
  const notes =
    noteIds.length > 0
      ? await anki.notesInfo(noteIds.slice(0, limit))
      : [];

  // Extract source info from tags
  const enriched = notes.map((note) => {
    const sourceTag = note.tags.find((t) => t.startsWith("source:") && !t.startsWith("source_id:") && !t.startsWith("source_title:"));
    const idTag = note.tags.find((t) => t.startsWith("source_id:"));
    const titleTag = note.tags.find((t) => t.startsWith("source_title:"));

    return {
      noteId: note.noteId,
      modelName: note.modelName,
      fields: Object.fromEntries(
        Object.entries(note.fields).map(([k, v]) => [k, v.value])
      ),
      tags: note.tags.filter(
        (t) =>
          !t.startsWith("source:") &&
          !t.startsWith("source_id:") &&
          !t.startsWith("source_title:") &&
          t !== "ankimaster"
      ),
      source: {
        type: sourceTag?.replace("source:", "") ?? null,
        id: idTag?.replace("source_id:", "") ?? null,
        title: titleTag?.replace("source_title:", "").replace(/-/g, " ") ?? null,
      },
    };
  });

  return json({
    query,
    total: noteIds.length,
    notes: enriched,
    truncated: noteIds.length > 50,
  });
}

// ── Helpers ──

function json(data: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

/**
 * Simple hash of a source URL to create a short, stable identifier.
 * Uses djb2 algorithm — fast, deterministic, no crypto deps.
 */
function hashSource(url: string): string {
  let hash = 5381;
  for (let i = 0; i < url.length; i++) {
    hash = ((hash << 5) + hash + url.charCodeAt(i)) & 0xffffffff;
  }
  return Math.abs(hash).toString(36);
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}
