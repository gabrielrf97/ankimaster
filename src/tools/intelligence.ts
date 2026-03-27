/**
 * Learning intelligence tools — the differentiator.
 *
 * Exposes review analytics, leech detection, weak area identification,
 * and card-level analysis that no other Anki MCP offers.
 */

import type { AnkiClient } from "../anki-client.js";

// ── Tool Schemas ──

export const intelligenceToolSchemas = [
  {
    name: "get_deck_stats",
    description:
      "Get deck-level learning overview: new/learn/review/total counts, plus aggregate ease and interval stats for mature cards.",
    inputSchema: {
      type: "object" as const,
      properties: {
        deck: {
          type: "string",
          description: "Deck name. Use '*' or omit for all decks.",
        },
      },
      required: [],
    },
  },
  {
    name: "get_review_stats",
    description:
      "Get review statistics for a deck: daily review counts (last 30 days), ease distribution, interval distribution, and estimated retention rate.",
    inputSchema: {
      type: "object" as const,
      properties: {
        deck: {
          type: "string",
          description: "Deck name to analyze",
        },
        days: {
          type: "number",
          description: "Number of days of history to analyze (default: 30)",
        },
      },
      required: ["deck"],
    },
  },
  {
    name: "find_leeches",
    description:
      "Find problem cards: leeches (high lapses), low ease cards, and cards you keep failing. Returns card content and stats so you can suggest rewrites.",
    inputSchema: {
      type: "object" as const,
      properties: {
        deck: {
          type: "string",
          description: "Deck to search (omit for all decks)",
        },
        minLapses: {
          type: "number",
          description:
            "Minimum lapse count to consider a card problematic (default: 4)",
        },
        maxEase: {
          type: "number",
          description:
            "Maximum ease percentage to consider a card struggling (default: 180). Anki default starting ease is 250%.",
        },
        limit: {
          type: "number",
          description: "Max cards to return (default: 20)",
        },
      },
      required: [],
    },
  },
  {
    name: "find_weak_areas",
    description:
      "Identify tags or decks with the worst retention — aggregates lapse and ease data grouped by tag. Helps find topics that need more attention.",
    inputSchema: {
      type: "object" as const,
      properties: {
        deck: {
          type: "string",
          description: "Deck to analyze (omit for all)",
        },
        groupBy: {
          type: "string",
          enum: ["tag", "deck"],
          description: "Group results by tag or deck (default: tag)",
        },
      },
      required: [],
    },
  },
  {
    name: "analyze_cards",
    description:
      "Deep analysis of specific cards: full review timeline, ease trajectory over time, interval progression, and lapse history. Use this to understand WHY a card is hard.",
    inputSchema: {
      type: "object" as const,
      properties: {
        cardIds: {
          type: "array",
          items: { type: "number" },
          description: "Card IDs to analyze (max 10)",
        },
      },
      required: ["cardIds"],
    },
  },
];

// ── Tool Handlers ──

export async function handleIntelligenceTool(
  name: string,
  args: Record<string, unknown>,
  anki: AnkiClient
): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  switch (name) {
    case "get_deck_stats":
      return getDeckStats(anki, args);
    case "get_review_stats":
      return getReviewStats(anki, args);
    case "find_leeches":
      return findLeeches(anki, args);
    case "find_weak_areas":
      return findWeakAreas(anki, args);
    case "analyze_cards":
      return analyzeCards(anki, args);
    default:
      throw new Error(`Unknown intelligence tool: ${name}`);
  }
}

// ── Implementations ──

async function getDeckStats(
  anki: AnkiClient,
  args: Record<string, unknown>
) {
  const deckName = (args.deck as string) || undefined;

  const allDecks = await anki.deckNames();
  const targetDecks = deckName && deckName !== "*"
    ? allDecks.filter((d) => d === deckName || d.startsWith(deckName + "::"))
    : allDecks;

  if (targetDecks.length === 0) {
    throw new Error(`Deck not found: ${deckName}`);
  }

  const basicStats = await anki.getDeckStats(targetDecks);

  // Get card-level stats for mature cards (interval >= 21 days)
  const query = deckName && deckName !== "*"
    ? `"deck:${deckName}" prop:ivl>=1`
    : "prop:ivl>=1";
  const cardIds = await anki.findCards(query);
  const sampleSize = 500;
  const sampled = cardIds.length > sampleSize;
  const cards = cardIds.length > 0
    ? await anki.cardsInfo(cardIds.slice(0, sampleSize))
    : [];

  const easeValues = cards.map((c) => c.factor / 10); // Convert to percentage
  const intervals = cards.map((c) => c.interval);
  const lapses = cards.map((c) => c.lapses);

  const matureCards = cards.filter((c) => c.interval >= 21);
  const youngCards = cards.filter((c) => c.interval > 0 && c.interval < 21);

  return json({
    sampled,
    ...(sampled ? { sampleSize, totalCards: cardIds.length } : {}),
    decks: basicStats,
    cardBreakdown: {
      total: cards.length,
      mature: matureCards.length,
      young: youngCards.length,
    },
    easeDistribution: cards.length > 0 ? {
      min: Math.min(...easeValues),
      max: Math.max(...easeValues),
      avg: Math.round(avg(easeValues)),
      median: median(easeValues),
    } : null,
    intervalDistribution: cards.length > 0 ? {
      minDays: Math.min(...intervals),
      maxDays: Math.max(...intervals),
      avgDays: Math.round(avg(intervals)),
      medianDays: median(intervals),
    } : null,
    lapseStats: cards.length > 0 ? {
      totalLapses: sum(lapses),
      avgPerCard: round2(avg(lapses)),
      cardsWithLapses: lapses.filter((l) => l > 0).length,
    } : null,
  });
}

async function getReviewStats(
  anki: AnkiClient,
  args: Record<string, unknown>
) {
  const deck = args.deck as string;
  if (!deck) throw new Error("Deck name is required");
  const days = (args.days as number) || 30;

  // Daily review counts
  const dailyReviews = await anki.getNumCardsReviewedByDay();
  const recentReviews = dailyReviews.slice(0, days);

  // Get review cards in this deck
  const cardIds = await anki.findCards(`"deck:${deck}" prop:ivl>=1`);
  const cardSampleSize = 500;
  const reviewSampleSize = 200;
  const cardsSampled = cardIds.length > cardSampleSize;
  const cards = cardIds.length > 0
    ? await anki.cardsInfo(cardIds.slice(0, cardSampleSize))
    : [];

  // Get review logs for retention estimation
  const sampleIds = cardIds.slice(0, 200).map(String);
  const reviewLogs = sampleIds.length > 0
    ? await anki.getReviewsOfCards(sampleIds)
    : {};

  // Estimate retention from review logs
  let totalReviews = 0;
  let lapseReviews = 0;
  for (const reviews of Object.values(reviewLogs)) {
    for (const r of reviews) {
      totalReviews++;
      if (r.ease === 1) lapseReviews++; // ease=1 means "Again"
    }
  }
  const estimatedRetention = totalReviews > 0
    ? Math.round(((totalReviews - lapseReviews) / totalReviews) * 100)
    : null;

  // Ease distribution buckets
  const easeBuckets = { "130-150%": 0, "151-200%": 0, "201-250%": 0, "251-300%": 0, "300%+": 0 };
  for (const c of cards) {
    const ease = c.factor / 10;
    if (ease <= 150) easeBuckets["130-150%"]++;
    else if (ease <= 200) easeBuckets["151-200%"]++;
    else if (ease <= 250) easeBuckets["201-250%"]++;
    else if (ease <= 300) easeBuckets["251-300%"]++;
    else easeBuckets["300%+"]++;
  }

  return json({
    deck,
    sampled: cardsSampled,
    ...(cardsSampled ? { cardSampleSize, reviewSampleSize, totalCards: cardIds.length } : {}),
    dailyReviews: recentReviews,
    totalCardsAnalyzed: cards.length,
    estimatedRetentionPercent: estimatedRetention,
    easeBuckets,
    avgEasePercent: cards.length > 0
      ? Math.round(avg(cards.map((c) => c.factor / 10)))
      : null,
    avgIntervalDays: cards.length > 0
      ? Math.round(avg(cards.map((c) => c.interval)))
      : null,
  });
}

async function findLeeches(
  anki: AnkiClient,
  args: Record<string, unknown>
) {
  const deck = args.deck as string | undefined;
  const minLapses = (args.minLapses as number) || 4;
  const maxEase = (args.maxEase as number) || 180;
  const limit = Math.min((args.limit as number) || 20, 50);

  // Find tagged leeches
  const leechQuery = deck
    ? `"deck:${deck}" tag:leech`
    : "tag:leech";
  const leechCardIds = await anki.findCards(leechQuery);

  // Find high-lapse cards
  const lapseQuery = deck
    ? `"deck:${deck}" prop:lapses>=${minLapses}`
    : `prop:lapses>=${minLapses}`;
  const lapseCardIds = await anki.findCards(lapseQuery);

  // Find low-ease cards
  const easeQuery = deck
    ? `"deck:${deck}" prop:ease<${maxEase / 100} prop:ivl>=1`
    : `prop:ease<${maxEase / 100} prop:ivl>=1`;
  const lowEaseCardIds = await anki.findCards(easeQuery);

  // Merge and deduplicate
  const allIds = [...new Set([...leechCardIds, ...lapseCardIds, ...lowEaseCardIds])];
  const limitedIds = allIds.slice(0, limit);

  if (limitedIds.length === 0) {
    return json({
      message: "No problem cards found!",
      criteria: { minLapses, maxEase, deck: deck ?? "all" },
    });
  }

  const cards = await anki.cardsInfo(limitedIds);
  // Get note info for card content
  const noteIds = [...new Set(cards.map((c) => c.note))];
  const notes = await anki.notesInfo(noteIds);
  const noteMap = new Map(notes.map((n) => [n.noteId, n]));

  const problems = cards
    .map((card) => {
      const note = noteMap.get(card.note);
      return {
        cardId: card.cardId,
        noteId: card.note,
        deckName: card.deckName,
        modelName: card.modelName,
        ease: Math.round(card.factor / 10),
        interval: card.interval,
        lapses: card.lapses,
        reps: card.reps,
        isLeech: leechCardIds.includes(card.cardId),
        isSuspended: card.queue === -1,
        fields: note
          ? Object.fromEntries(
              Object.entries(note.fields).map(([k, v]) => [k, v.value])
            )
          : {},
        tags: note?.tags ?? [],
      };
    })
    .sort((a, b) => b.lapses - a.lapses);

  return json({
    totalFound: allIds.length,
    returned: problems.length,
    criteria: { minLapses, maxEase, deck: deck ?? "all" },
    cards: problems,
  });
}

async function findWeakAreas(
  anki: AnkiClient,
  args: Record<string, unknown>
) {
  const deck = args.deck as string | undefined;
  const groupBy = (args.groupBy as string) || "tag";

  // Get all reviewed cards
  const query = deck
    ? `"deck:${deck}" prop:ivl>=1`
    : "prop:ivl>=1";
  const cardIds = await anki.findCards(query);
  const weakAreaSampleSize = 1000;
  const sampled = cardIds.length > weakAreaSampleSize;
  const cards = cardIds.length > 0
    ? await anki.cardsInfo(cardIds.slice(0, weakAreaSampleSize))
    : [];

  if (cards.length === 0) {
    return json({ message: "No reviewed cards found", groupBy });
  }

  const sampledMeta = sampled
    ? { sampled: true, sampleSize: weakAreaSampleSize, totalCards: cardIds.length }
    : { sampled: false };

  if (groupBy === "deck") {
    const deckGroups = new Map<
      string,
      { eases: number[]; lapses: number[]; intervals: number[]; count: number }
    >();

    for (const card of cards) {
      const group = deckGroups.get(card.deckName) ?? {
        eases: [],
        lapses: [],
        intervals: [],
        count: 0,
      };
      group.eases.push(card.factor / 10);
      group.lapses.push(card.lapses);
      group.intervals.push(card.interval);
      group.count++;
      deckGroups.set(card.deckName, group);
    }

    const areas = [...deckGroups.entries()]
      .map(([name, g]) => ({
        name,
        cardCount: g.count,
        avgEase: Math.round(avg(g.eases)),
        avgLapses: round2(avg(g.lapses)),
        totalLapses: sum(g.lapses),
        avgIntervalDays: Math.round(avg(g.intervals)),
        difficultyScore: round2(
          avg(g.lapses) * 100 + (300 - avg(g.eases))
        ),
      }))
      .sort((a, b) => b.difficultyScore - a.difficultyScore);

    return json({ groupBy: "deck", ...sampledMeta, areas });
  }

  // Group by tag
  const noteIds = [...new Set(cards.map((c) => c.note))];
  const notes = await anki.notesInfo(noteIds.slice(0, 500));
  const noteMap = new Map(notes.map((n) => [n.noteId, n]));

  const tagGroups = new Map<
    string,
    { eases: number[]; lapses: number[]; intervals: number[]; count: number }
  >();

  for (const card of cards) {
    const note = noteMap.get(card.note);
    const tags = note?.tags ?? ["untagged"];
    if (tags.length === 0) tags.push("untagged");

    for (const tag of tags) {
      // Skip internal tags
      if (tag.startsWith("source:") || tag.startsWith("source_id:") || tag === "ankimaster") continue;

      const group = tagGroups.get(tag) ?? {
        eases: [],
        lapses: [],
        intervals: [],
        count: 0,
      };
      group.eases.push(card.factor / 10);
      group.lapses.push(card.lapses);
      group.intervals.push(card.interval);
      group.count++;
      tagGroups.set(tag, group);
    }
  }

  const areas = [...tagGroups.entries()]
    .filter(([_, g]) => g.count >= 3) // Minimum 3 cards to be meaningful
    .map(([name, g]) => ({
      tag: name,
      cardCount: g.count,
      avgEase: Math.round(avg(g.eases)),
      avgLapses: round2(avg(g.lapses)),
      totalLapses: sum(g.lapses),
      avgIntervalDays: Math.round(avg(g.intervals)),
      difficultyScore: round2(
        avg(g.lapses) * 100 + (300 - avg(g.eases))
      ),
    }))
    .sort((a, b) => b.difficultyScore - a.difficultyScore);

  return json({ groupBy: "tag", ...sampledMeta, areas });
}

async function analyzeCards(
  anki: AnkiClient,
  args: Record<string, unknown>
) {
  const cardIds = args.cardIds as number[];
  if (!cardIds?.length) throw new Error("cardIds array is required");
  if (cardIds.length > 10) throw new Error("Maximum 10 cards per analysis");

  const cards = await anki.cardsInfo(cardIds);
  const reviewLogs = await anki.getReviewsOfCards(
    cardIds.map(String)
  );

  // Get note content
  const noteIds = [...new Set(cards.map((c) => c.note))];
  const notes = await anki.notesInfo(noteIds);
  const noteMap = new Map(notes.map((n) => [n.noteId, n]));

  const analyses = cards.map((card) => {
    const reviews = reviewLogs[String(card.cardId)] ?? [];
    const note = noteMap.get(card.note);

    // Sort reviews by time (oldest first)
    const sorted = [...reviews].sort((a, b) => a.id - b.id);

    // Ease trajectory over time
    const easeTrajectory = sorted
      .filter((r) => r.factor > 0)
      .map((r) => ({
        date: new Date(r.id).toISOString().split("T")[0],
        ease: Math.round(r.factor / 10),
        interval: r.ivl,
        rating: r.ease, // 1=Again, 2=Hard, 3=Good, 4=Easy
      }));

    // Rating distribution
    const ratings = { again: 0, hard: 0, good: 0, easy: 0 };
    for (const r of sorted) {
      if (r.ease === 1) ratings.again++;
      else if (r.ease === 2) ratings.hard++;
      else if (r.ease === 3) ratings.good++;
      else if (r.ease === 4) ratings.easy++;
    }

    return {
      cardId: card.cardId,
      noteId: card.note,
      deckName: card.deckName,
      modelName: card.modelName,
      currentState: {
        ease: Math.round(card.factor / 10),
        interval: card.interval,
        lapses: card.lapses,
        reps: card.reps,
        type: ["new", "learning", "review", "relearning"][card.type] ?? "unknown",
        queue: card.queue === -1 ? "suspended" : card.queue === -2 ? "buried" : "active",
      },
      fields: note
        ? Object.fromEntries(
            Object.entries(note.fields).map(([k, v]) => [k, v.value])
          )
        : {},
      tags: note?.tags ?? [],
      reviewCount: sorted.length,
      ratingDistribution: ratings,
      retentionRate: sorted.length > 0
        ? Math.round(
            ((sorted.length - ratings.again) / sorted.length) * 100
          )
        : null,
      easeTrajectory,
    };
  });

  return json({ analyses });
}

// ── Math helpers ──

function json(data: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function avg(nums: number[]): number {
  return nums.length === 0 ? 0 : sum(nums) / nums.length;
}

function sum(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0);
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
