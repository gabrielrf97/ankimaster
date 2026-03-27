/**
 * Raw fetch() wrapper for AnkiConnect — zero dependencies.
 *
 * AnkiConnect exposes a JSON-RPC-style API on localhost:8765.
 * Every request is POST with { action, version, params }.
 */

export class AnkiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnkiError";
  }
}

export class AnkiConnectionError extends AnkiError {
  constructor(message: string) {
    super(message);
    this.name = "AnkiConnectionError";
  }
}

export interface AnkiClientConfig {
  host: string;
  port: number;
}

const DEFAULT_CONFIG: AnkiClientConfig = {
  host: "localhost",
  port: 8765,
};

export class AnkiClient {
  private url: string;

  constructor(config: Partial<AnkiClientConfig> = {}) {
    const { host, port } = { ...DEFAULT_CONFIG, ...config };
    this.url = `http://${host}:${port}`;
  }

  /**
   * Core invoke — every AnkiConnect call goes through here.
   */
  async invoke<T = unknown>(
    action: string,
    params?: Record<string, unknown>
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, version: 6, params }),
      });
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : String(err);
      if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
        throw new AnkiConnectionError(
          "Cannot connect to Anki. Make sure Anki is running with AnkiConnect installed."
        );
      }
      throw new AnkiError(`AnkiConnect request failed: ${msg}`);
    }

    const json = await res.json();
    if (json.error) {
      throw new AnkiError(json.error);
    }
    return json.result as T;
  }

  /**
   * Invoke with a single retry and exponential backoff.
   */
  private async invokeWithRetry<T = unknown>(
    action: string,
    params?: Record<string, unknown>
  ): Promise<T> {
    try {
      return await this.invoke<T>(action, params);
    } catch (err) {
      if (err instanceof AnkiConnectionError) throw err;
      // One retry after 500ms
      await new Promise((r) => setTimeout(r, 500));
      return this.invoke<T>(action, params);
    }
  }

  // ── Connection ──

  async checkConnection(): Promise<number> {
    return this.invoke<number>("version");
  }

  // ── Decks ──

  async deckNames(): Promise<string[]> {
    return this.invokeWithRetry<string[]>("deckNames");
  }

  async createDeck(deck: string): Promise<number> {
    return this.invokeWithRetry<number>("createDeck", { deck });
  }

  async getDeckStats(
    decks: string[]
  ): Promise<
    Record<
      string,
      {
        deck_id: number;
        name: string;
        new_count: number;
        learn_count: number;
        review_count: number;
        total_in_deck: number;
      }
    >
  > {
    return this.invokeWithRetry("getDeckStats", { decks });
  }

  // ── Models ──

  async modelNames(): Promise<string[]> {
    return this.invokeWithRetry<string[]>("modelNames");
  }

  async modelFieldNames(modelName: string): Promise<string[]> {
    return this.invokeWithRetry<string[]>("modelFieldNames", { modelName });
  }

  // ── Notes ──

  async addNote(note: {
    deckName: string;
    modelName: string;
    fields: Record<string, string>;
    tags?: string[];
    options?: { allowDuplicate?: boolean };
  }): Promise<number | null> {
    return this.invokeWithRetry<number | null>("addNote", {
      note: {
        ...note,
        tags: note.tags ?? [],
        options: {
          allowDuplicate: note.options?.allowDuplicate ?? false,
          duplicateScope: "deck",
        },
      },
    });
  }

  async addNotes(
    notes: {
      deckName: string;
      modelName: string;
      fields: Record<string, string>;
      tags?: string[];
    }[]
  ): Promise<(number | null)[]> {
    return this.invokeWithRetry("addNotes", {
      notes: notes.map((n) => ({
        ...n,
        tags: n.tags ?? [],
        options: { allowDuplicate: false, duplicateScope: "deck" },
      })),
    });
  }

  async findNotes(query: string): Promise<number[]> {
    return this.invokeWithRetry<number[]>("findNotes", { query });
  }

  async notesInfo(
    notes: number[]
  ): Promise<
    {
      noteId: number;
      modelName: string;
      tags: string[];
      fields: Record<string, { value: string; order: number }>;
    }[]
  > {
    return this.invokeWithRetry("notesInfo", { notes });
  }

  async updateNoteFields(note: {
    id: number;
    fields: Record<string, string>;
  }): Promise<void> {
    await this.invokeWithRetry("updateNoteFields", { note });
  }

  async updateNoteTags(
    note: number,
    tags: string
  ): Promise<void> {
    await this.invokeWithRetry("addTags", { notes: [note], tags });
  }

  async deleteNotes(notes: number[]): Promise<void> {
    await this.invokeWithRetry("deleteNotes", { notes });
  }

  // ── Cards ──

  async findCards(query: string): Promise<number[]> {
    return this.invokeWithRetry<number[]>("findCards", { query });
  }

  async cardsInfo(
    cards: number[]
  ): Promise<
    {
      cardId: number;
      fields: Record<string, { value: string; order: number }>;
      fieldOrder: number;
      question: string;
      answer: string;
      modelName: string;
      ord: number;
      deckName: string;
      css: string;
      factor: number; // ease as integer, 2500 = 250%
      interval: number; // days
      note: number; // note ID
      type: number; // 0=new, 1=learning, 2=review, 3=relearning
      queue: number; // -1=suspended, -2=buried, 0=new, 1=learning, 2=review, 3=day-learn
      due: number;
      reps: number;
      lapses: number;
      left: number;
      mod: number;
    }[]
  > {
    return this.invokeWithRetry("cardsInfo", { cards });
  }

  async getReviewsOfCards(
    cards: string[]
  ): Promise<
    Record<
      string,
      {
        id: number;
        usn: number;
        ease: number;
        ivl: number;
        lastIvl: number;
        factor: number;
        time: number;
        type: number;
      }[]
    >
  > {
    return this.invokeWithRetry("getReviewsOfCards", { cards });
  }

  async getNumCardsReviewedByDay(): Promise<[string, number][]> {
    return this.invokeWithRetry("getNumCardsReviewedByDay");
  }
}
