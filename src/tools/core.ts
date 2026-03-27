/**
 * Core CRUD tools for decks, notes, and note types.
 */

import type { AnkiClient } from "../anki-client.js";

// ── Sanitization ──

const DANGEROUS_TAGS = /<\s*(script|iframe|embed|object|form|input|link|meta)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>|<\s*(script|iframe|embed|object|form|input|link|meta)[^>]*\/?>/gi;
const TRACKING_PIXELS = /<img[^>]+src\s*=\s*["']https?:\/\/[^"']+["'][^>]*(?:width|height)\s*=\s*["']?[01](?:px)?["']?[^>]*\/?>/gi;
const EVENT_HANDLERS = /\s+on\w+\s*=\s*["'][^"']*["']/gi;

function sanitizeHtml(html: string): string {
  return html
    .replace(DANGEROUS_TAGS, "")
    .replace(TRACKING_PIXELS, "")
    .replace(EVENT_HANDLERS, "");
}

function sanitizeFields(
  fields: Record<string, string>
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    sanitized[key] = sanitizeHtml(value);
  }
  return sanitized;
}

// ── Tool Schemas ──

export const coreToolSchemas = [
  {
    name: "list_decks",
    description: "List all available Anki decks",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "create_deck",
    description: "Create a new Anki deck",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Name of the deck to create" },
      },
      required: ["name"],
    },
  },
  {
    name: "create_note",
    description:
      "Create a single note. Call list_note_types first to see available types and their fields.",
    inputSchema: {
      type: "object" as const,
      properties: {
        type: {
          type: "string",
          description:
            "Note type. Common: 'Basic' (Front/Back), 'Cloze' (Text with {{c1::deletions}})",
        },
        deck: { type: "string", description: "Target deck name" },
        fields: {
          type: "object",
          description:
            "Note fields. Basic: {Front: '...', Back: '...'}. Cloze: {Text: '...{{c1::...}}'}",
          additionalProperties: { type: "string" },
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags",
        },
        allowDuplicate: {
          type: "boolean",
          description: "Allow duplicate notes (default: false)",
        },
      },
      required: ["type", "deck", "fields"],
    },
  },
  {
    name: "batch_create_notes",
    description:
      "Create multiple notes at once. 10-20 per batch recommended, max 50.",
    inputSchema: {
      type: "object" as const,
      properties: {
        notes: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              type: { type: "string", description: "Note type" },
              deck: { type: "string", description: "Target deck" },
              fields: {
                type: "object",
                additionalProperties: { type: "string" },
              },
              tags: { type: "array", items: { type: "string" } },
            },
            required: ["type", "deck", "fields"],
          },
        },
        allowDuplicate: { type: "boolean" },
      },
      required: ["notes"],
    },
  },
  {
    name: "search_notes",
    description:
      "Search notes using Anki query syntax (e.g. 'deck:MyDeck', 'tag:mytag', 'front:*keyword*')",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Anki search query" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_note_info",
    description: "Get detailed information about a note by ID",
    inputSchema: {
      type: "object" as const,
      properties: {
        noteId: { type: "number", description: "Note ID" },
      },
      required: ["noteId"],
    },
  },
  {
    name: "update_note",
    description: "Update an existing note's fields and/or tags",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "number", description: "Note ID" },
        fields: {
          type: "object",
          description: "Fields to update",
          additionalProperties: { type: "string" },
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "New tags (replaces existing)",
        },
      },
      required: ["id", "fields"],
    },
  },
  {
    name: "delete_note",
    description: "Delete a note by ID",
    inputSchema: {
      type: "object" as const,
      properties: {
        noteId: { type: "number", description: "Note ID to delete" },
      },
      required: ["noteId"],
    },
  },
  {
    name: "list_note_types",
    description:
      "List all available note types and their fields. Use this before creating notes to know which fields to fill.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
];

// ── Tool Handlers ──

export async function handleCoreTool(
  name: string,
  args: Record<string, unknown>,
  anki: AnkiClient
): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  switch (name) {
    case "list_decks": {
      const decks = await anki.deckNames();
      return json({ decks, count: decks.length });
    }

    case "create_deck": {
      const deckName = args.name as string;
      if (!deckName) throw new Error("Deck name is required");
      const deckId = await anki.createDeck(deckName);
      return json({ deckId, name: deckName });
    }

    case "create_note": {
      const { type, deck, fields, tags, allowDuplicate } = args as {
        type: string;
        deck: string;
        fields: Record<string, string>;
        tags?: string[];
        allowDuplicate?: boolean;
      };
      if (!type || !deck || !fields)
        throw new Error("type, deck, and fields are required");

      await ensureDeck(anki, deck);
      const modelFields = await anki.modelFieldNames(type);
      const normalized = normalizeFields(modelFields, sanitizeFields(fields));

      const noteId = await anki.addNote({
        deckName: deck,
        modelName: type,
        fields: normalized,
        tags,
        options: { allowDuplicate },
      });
      return json({ noteId, deck, type });
    }

    case "batch_create_notes": {
      const { notes, allowDuplicate } = args as {
        notes: {
          type: string;
          deck: string;
          fields: Record<string, string>;
          tags?: string[];
        }[];
        allowDuplicate?: boolean;
      };
      if (!notes?.length) throw new Error("Notes array is required");

      const results: {
        success: boolean;
        noteId?: number | null;
        error?: string;
        index: number;
      }[] = [];

      for (let i = 0; i < notes.length; i++) {
        const note = notes[i];
        try {
          await ensureDeck(anki, note.deck);
          const modelFields = await anki.modelFieldNames(note.type);
          const normalized = normalizeFields(
            modelFields,
            sanitizeFields(note.fields)
          );
          const noteId = await anki.addNote({
            deckName: note.deck,
            modelName: note.type,
            fields: normalized,
            tags: note.tags,
            options: { allowDuplicate },
          });
          results.push({ success: true, noteId, index: i });
        } catch (err) {
          results.push({
            success: false,
            error: err instanceof Error ? err.message : String(err),
            index: i,
          });
        }
      }

      return json({
        results,
        total: notes.length,
        successful: results.filter((r) => r.success).length,
        failed: results.filter((r) => !r.success).length,
      });
    }

    case "search_notes": {
      const query = args.query as string;
      if (!query) throw new Error("Search query is required");
      const noteIds = await anki.findNotes(query);
      const limit = Math.min(noteIds.length, 50);
      const notes =
        noteIds.length > 0
          ? await anki.notesInfo(noteIds.slice(0, limit))
          : [];
      return json({
        query,
        total: noteIds.length,
        notes,
        truncated: noteIds.length > 50,
      });
    }

    case "get_note_info": {
      const noteId = args.noteId as number;
      if (!noteId) throw new Error("Note ID is required");
      const info = await anki.notesInfo([noteId]);
      if (!info?.length) throw new Error(`Note not found: ${noteId}`);
      return json(info[0]);
    }

    case "update_note": {
      const { id, fields, tags } = args as {
        id: number;
        fields: Record<string, string>;
        tags?: string[];
      };
      if (!id || !fields) throw new Error("id and fields are required");

      const info = await anki.notesInfo([id]);
      if (!info?.length) throw new Error(`Note not found: ${id}`);

      await anki.updateNoteFields({ id, fields: sanitizeFields(fields) });
      if (tags) {
        await anki.updateNoteTags(id, tags.join(" "));
      }
      return json({ success: true, noteId: id });
    }

    case "delete_note": {
      const noteId = args.noteId as number;
      if (!noteId) throw new Error("Note ID is required");
      await anki.deleteNotes([noteId]);
      return json({ success: true, noteId });
    }

    case "list_note_types": {
      const names = await anki.modelNames();
      const types = await Promise.all(
        names.map(async (name) => ({
          name,
          fields: await anki.modelFieldNames(name),
        }))
      );
      return json({ noteTypes: types, count: types.length });
    }

    default:
      throw new Error(`Unknown core tool: ${name}`);
  }
}

// ── Helpers ──

function json(data: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

async function ensureDeck(anki: AnkiClient, deck: string) {
  const decks = await anki.deckNames();
  if (!decks.includes(deck)) {
    await anki.createDeck(deck);
  }
}

function normalizeFields(
  modelFields: string[],
  fields: Record<string, string>
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const field of modelFields) {
    normalized[field] =
      fields[field] ?? fields[field.toLowerCase()] ?? "";
  }
  return normalized;
}
