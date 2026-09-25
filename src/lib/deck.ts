// ============================================================================
// Monopoly Deal card & deck definitions.
//
// All quantities (money, the 28 standard properties, 11 wildcards, 13 rent
// cards, and every action card) are confirmed against a physical deck.
// This file is duplicated (not imported) into
// supabase/functions/game-actions/deck.ts because Edge Functions run on
// Deno as a separate build — keep both in sync if you edit either.
// ============================================================================

export type PropertyColor =
  | "brown"
  | "lightblue"
  | "pink"
  | "orange"
  | "red"
  | "yellow"
  | "green"
  | "darkblue"
  | "railroad"
  | "utility";

export const SET_SIZE: Record<PropertyColor, number> = {
  brown: 2,
  lightblue: 3,
  pink: 3,
  orange: 3,
  red: 3,
  yellow: 3,
  green: 3,
  darkblue: 2,
  railroad: 4,
  utility: 2,
};

export const COLOR_LABEL: Record<PropertyColor, string> = {
  brown: "Brown",
  lightblue: "Light Blue",
  pink: "Purple",
  orange: "Orange",
  red: "Red",
  yellow: "Yellow",
  green: "Green",
  darkblue: "Dark Blue",
  railroad: "Railroad",
  utility: "Utility",
};

export interface PropertyCard {
  id: string;
  kind: "property";
  name: string;
  color: PropertyColor;
  value: number;
  rents: number[]; // rent by number of cards owned in the set, e.g. [1,2,4]
}

export interface WildcardCard {
  id: string;
  kind: "wildcard";
  name: string;
  colors: PropertyColor[]; // 2 colors, or all 10 for the fully-wild card
  value: number;
}

export interface MoneyCard {
  id: string;
  kind: "money";
  value: number;
}

export type ActionType =
  | "deal_breaker"
  | "just_say_no"
  | "sly_deal"
  | "forced_deal"
  | "debt_collector"
  | "birthday"
  | "double_rent"
  | "house"
  | "hotel"
  | "pass_go"
  | "rent"
  | "rent_wild";

export interface ActionCard {
  id: string;
  kind: "action";
  action: ActionType;
  name: string;
  value: number;
  rentColors?: PropertyColor[]; // for "rent" cards: which 2 colors it charges for
}

export type Card = PropertyCard | WildcardCard | MoneyCard | ActionCard;

// ----------------------------------------------------------------------------
// Property cards: name, value, rent ladder, per official card text.
// ----------------------------------------------------------------------------

interface ColorDef {
  names: string[]; // one entry per card in the set, in print order
  value: number;
  rents: number[];
}

const COLOR_DEFS: Record<PropertyColor, ColorDef> = {
  brown: { names: ["Mediterranean Avenue", "Baltic Avenue"], value: 1, rents: [1, 2] },
  lightblue: {
    names: ["Oriental Avenue", "Vermont Avenue", "Connecticut Avenue"],
    value: 1,
    rents: [1, 2, 3],
  },
  pink: {
    names: ["St. Charles Place", "States Avenue", "Virginia Avenue"],
    value: 2,
    rents: [1, 2, 4],
  },
  orange: {
    names: ["St. James Place", "Tennessee Avenue", "New York Avenue"],
    value: 2,
    rents: [1, 3, 5],
  },
  red: {
    names: ["Kentucky Avenue", "Indiana Avenue", "Illinois Avenue"],
    value: 3,
    rents: [2, 3, 6],
  },
  yellow: {
    names: ["Atlantic Avenue", "Ventnor Avenue", "Marvin Gardens"],
    value: 3,
    rents: [2, 4, 6],
  },
  green: {
    names: ["Pacific Avenue", "North Carolina Avenue", "Pennsylvania Avenue"],
    value: 4,
    rents: [2, 4, 7],
  },
  darkblue: { names: ["Park Place", "Boardwalk"], value: 4, rents: [3, 8] },
  railroad: {
    names: ["Reading Railroad", "Pennsylvania Railroad", "B&O Railroad", "Short Line"],
    value: 2,
    rents: [1, 2, 3, 4],
  },
  utility: { names: ["Electric Company", "Water Works"], value: 2, rents: [1, 2] },
};

// Two-color wildcards + the 2 fully-wild ("any color") cards.
const WILDCARD_DEFS: { colors: PropertyColor[]; count: number }[] = [
  { colors: ["lightblue", "brown"], count: 1 },
  { colors: ["pink", "orange"], count: 2 },
  { colors: ["red", "yellow"], count: 2 },
  { colors: ["green", "darkblue"], count: 1 },
  { colors: ["railroad", "lightblue"], count: 1 },
  { colors: ["railroad", "green"], count: 1 },
  { colors: ["railroad", "utility"], count: 1 },
  {
    colors: [
      "brown",
      "lightblue",
      "pink",
      "orange",
      "red",
      "yellow",
      "green",
      "darkblue",
      "railroad",
      "utility",
    ],
    count: 2,
  },
];

const MONEY_DEFS: { value: number; count: number }[] = [
  { value: 1, count: 6 },
  { value: 2, count: 5 },
  { value: 3, count: 3 },
  { value: 4, count: 3 },
  { value: 5, count: 2 },
  { value: 10, count: 1 },
];

const RENT_PAIRS: PropertyColor[][] = [
  ["brown", "lightblue"],
  ["pink", "orange"],
  ["red", "yellow"],
  ["green", "darkblue"],
  ["railroad", "utility"],
];

const ALL_COLORS: PropertyColor[] = [
  "brown",
  "lightblue",
  "pink",
  "orange",
  "red",
  "yellow",
  "green",
  "darkblue",
  "railroad",
  "utility",
];

export const RENTS: Record<PropertyColor, number[]> = Object.fromEntries(
  ALL_COLORS.map((c) => [c, COLOR_DEFS[c].rents])
) as Record<PropertyColor, number[]>;

// House/Hotel can only be added to a complete Railroad-free, Utility-free
// color set per the official rules.
export const NO_BUILDING_COLORS: PropertyColor[] = ["railroad", "utility"];

const ACTION_DEFS: {
  action: ActionType;
  name: string;
  value: number;
  count: number;
}[] = [
  { action: "pass_go", name: "Pass Go", value: 1, count: 10 },
  { action: "house", name: "House", value: 3, count: 3 },
  { action: "hotel", name: "Hotel", value: 4, count: 3 },
  { action: "deal_breaker", name: "Deal Breaker", value: 5, count: 2 },
  { action: "just_say_no", name: "Just Say No", value: 4, count: 3 },
  { action: "sly_deal", name: "Sly Deal", value: 3, count: 3 },
  { action: "forced_deal", name: "Forced Deal", value: 3, count: 4 },
  { action: "debt_collector", name: "Debt Collector", value: 3, count: 3 },
  { action: "birthday", name: "It's My Birthday", value: 2, count: 3 },
  { action: "double_rent", name: "Double The Rent", value: 1, count: 2 },
];

let idCounter = 0;
function nextId(prefix: string) {
  idCounter += 1;
  return `${prefix}_${idCounter}`;
}

export function buildFullDeck(): Card[] {
  idCounter = 0;
  const deck: Card[] = [];

  for (const color of ALL_COLORS) {
    const def = COLOR_DEFS[color];
    for (const name of def.names) {
      deck.push({
        id: nextId("prop"),
        kind: "property",
        name,
        color,
        value: def.value,
        rents: def.rents,
      });
    }
  }

  for (const w of WILDCARD_DEFS) {
    for (let i = 0; i < w.count; i++) {
      deck.push({
        id: nextId("wild"),
        kind: "wildcard",
        name:
          w.colors.length > 2
            ? "Property Wildcard (any color)"
            : `${COLOR_LABEL[w.colors[0]]} / ${COLOR_LABEL[w.colors[1]]} Wildcard`,
        colors: w.colors,
        value: w.colors.length > 2 ? 0 : 1,
      });
    }
  }

  for (const m of MONEY_DEFS) {
    for (let i = 0; i < m.count; i++) {
      deck.push({ id: nextId("money"), kind: "money", value: m.value });
    }
  }

  for (const pair of RENT_PAIRS) {
    for (let i = 0; i < 2; i++) {
      deck.push({
        id: nextId("rent"),
        kind: "action",
        action: "rent",
        name: `Rent (${COLOR_LABEL[pair[0]]} / ${COLOR_LABEL[pair[1]]})`,
        value: 1,
        rentColors: pair,
      });
    }
  }
  for (let i = 0; i < 3; i++) {
    deck.push({
      id: nextId("rentw"),
      kind: "action",
      action: "rent_wild",
      name: "Rent (any color)",
      value: 3,
    });
  }

  for (const a of ACTION_DEFS) {
    for (let i = 0; i < a.count; i++) {
      deck.push({ id: nextId("act"), kind: "action", action: a.action, name: a.name, value: a.value });
    }
  }

  return deck;
}

export function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
