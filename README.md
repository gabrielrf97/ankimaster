# ankimaster

Anki MCP server with **learning intelligence** and a **source-to-cards pipeline**.

Unlike other Anki MCPs that only do CRUD, ankimaster exposes your review analytics, finds your leeches and weak areas, and lets you create flashcards with full source traceability — so an LLM can pull from Notion, Obsidian, or any source and you always know where each card came from.

## Prerequisites

- [Anki](https://apps.ankiweb.net/) running
- [AnkiConnect](https://ankiweb.net/shared/info/2055492159) addon installed (Tools > Add-ons > Get Add-ons > code `2055492159`)

## Installation

### Claude Desktop / Claude Code

Add to your MCP config:

```json
{
  "mcpServers": {
    "ankimaster": {
      "command": "npx",
      "args": ["ankimaster"]
    }
  }
}
```

### From source

```bash
git clone https://github.com/gabrielrf97/ankimaster.git
cd ankimaster
npm install && npm run build
```

Then point your MCP client to `node dist/index.js`.

### CLI options

```
--port <number>   AnkiConnect port (default: 8765)
--host <string>   AnkiConnect host (default: localhost)
```

## Tools

### Core (8 tools)

| Tool | Description |
|------|-------------|
| `list_decks` | List all decks |
| `create_deck` | Create a deck |
| `create_note` | Create a single note |
| `batch_create_notes` | Create multiple notes (max 50) |
| `search_notes` | Search using Anki query syntax |
| `get_note_info` | Get note details by ID |
| `update_note` | Update note fields/tags |
| `delete_note` | Delete a note |
| `list_note_types` | List note types with their fields |

### Learning Intelligence (5 tools)

| Tool | Description |
|------|-------------|
| `get_deck_stats` | Deck overview: card counts, ease/interval distributions, lapse stats |
| `get_review_stats` | Review history, retention estimation, ease buckets |
| `find_leeches` | Find problem cards: high lapses, low ease, tagged leeches — with card content for rewriting |
| `find_weak_areas` | Identify worst-performing tags or decks by aggregated difficulty score |
| `analyze_cards` | Deep card analysis: full review timeline, ease trajectory, rating distribution |

### Source-to-Cards (2 tools)

| Tool | Description |
|------|-------------|
| `create_source_cards` | Create cards with source attribution (Notion, Obsidian, PDF, URL). Auto-tags with source type, ID, and title |
| `get_source_cards` | Find cards from a specific source — check before creating to avoid duplicates |

## Source-to-Cards Workflow

ankimaster uses Anki's native tag system for source attribution. Every card created through `create_source_cards` gets tagged with:

- `ankimaster` — identifies cards created through this tool
- `source:{type}` — the source type (notion, obsidian, pdf, url, manual)
- `source_id:{hash}` — deterministic hash of the source URL for lookup
- `source_title:{slug}` — slugified source title

### Example: Notion integration

With a Notion MCP also connected, the LLM can:

1. Read a Notion page via the Notion MCP
2. Call `get_source_cards` to check if cards already exist from that page
3. Generate flashcards from the content
4. Call `create_source_cards` with the Notion page URL as the source

Same pattern works for Obsidian, PDFs, web pages, or any source the LLM can access.

## Security

- **HTML sanitization**: Card content is sanitized — `<script>`, `<iframe>`, tracking pixels, and event handlers are stripped
- **Zero unnecessary deps**: Only `@modelcontextprotocol/sdk` as a production dependency. Raw `fetch()` to AnkiConnect instead of third-party wrappers
- **No telemetry, no external calls**: Only talks to your local AnkiConnect instance

## License

MIT
