// The search page's saved search (lib/search-state.ts): load the state a
// `?q=<id>` names, save a new state for its id, and the view settings plugins
// keep in it (useSearchSetting).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useState } from "react";
import { api } from "./api";
import { NODE } from "./base";
import {
  canonicalState,
  isEmptyState,
  isSearchId,
  type SearchState,
  stateKey,
} from "./search-state";

export interface SavedSearchOut {
  id: string;
  state: SearchState;
  created_at: string;
}

const savedKey = (id: string | undefined) => ["saved-search", NODE, id] as const;

// Ids this tab already has for a state, so going back to an earlier state
// reuses its id without asking again; and the searches it saved, so opening
// one does not load it (or count it as opened).
const knownIds = new Map<string, string>();
const savedHere = new Map<string, SavedSearchOut>();

/** Store a state (a legacy link's, the search page's) and resolve to its id;
 * undefined for the default search, which needs none. */
export async function saveSearchState(
  state: SearchState,
  at: SearchPlace,
): Promise<string | undefined> {
  const canonical = canonicalState(state);
  if (isEmptyState(canonical)) return undefined;
  const key = stateKey(canonical);
  const known = knownIds.get(key);
  if (known) return known;
  const out = await api<SavedSearchOut>("/searches", {
    json: { state: canonical, level: at.level, view: at.view },
  });
  knownIds.set(key, out.id);
  savedHere.set(out.id, out);
  return out.id;
}

/** Where the search page is (path segments), for the API's usage counts. */
export interface SearchPlace {
  level?: string;
  view?: string;
}

/**
 * The state behind `q` (undefined: the default search). `ready` is false while
 * a link's state loads; `missing` when its id is unknown (the default search
 * shows). `save` stores a state and resolves to its id (undefined for the
 * default search, which needs none).
 */
export function useSavedSearch(q: string | undefined, place: SearchPlace) {
  const queryClient = useQueryClient();
  const id = isSearchId(q) ? q : undefined;
  const saved = useQuery({
    queryKey: savedKey(id),
    queryFn: () => {
      const params = new URLSearchParams();
      if (place.level) params.set("level", place.level);
      if (place.view) params.set("view", place.view);
      return api<SavedSearchOut>(`/searches/${id}?${params}`);
    },
    initialData: () => (id ? savedHere.get(id) : undefined),
    enabled: !!id,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  if (saved.data) knownIds.set(stateKey(saved.data.state), saved.data.id);

  const save = useCallback(
    async (state: SearchState, at: SearchPlace): Promise<string | undefined> => {
      const next = await saveSearchState(state, at);
      const out = next ? savedHere.get(next) : undefined;
      if (out) queryClient.setQueryData(savedKey(out.id), out);
      return next;
    },
    [queryClient],
  );

  return {
    state: id ? saved.data?.state : ({} as SearchState),
    ready: !id || saved.isSuccess || saved.isError,
    missing: !!id && saved.isError,
    save,
  };
}

/** The open search's view settings and how to change one (undefined: back to
 * its default). Null outside a search page's results. */
export interface SearchSettings {
  settings: Record<string, unknown>;
  set: (key: string, value: unknown) => void;
}

export const SearchSettingsContext = createContext<SearchSettings | null>(null);

function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A view setting kept in the search's saved state, so a shared link opens the
 * view as it was (the map's color-by, the poles plot's toggles): `key` is
 * "<plugin>.<name>" (lowercase, digits, `._-`). Like useState, with `fallback`
 * as its default; a value equal to it is not stored. A stored value `valid`
 * refuses reads as the default. Outside the search page (a contribution's
 * modal, a plugin page) it is plain component state.
 */
export function useSearchSetting<T>(
  key: string,
  fallback: T,
  valid?: (value: unknown) => boolean,
): [T, (next: T) => void] {
  const ctx = useContext(SearchSettingsContext);
  const [local, setLocal] = useState<T>(fallback);
  const fallbackKey = JSON.stringify(fallback);
  // biome-ignore lint/correctness/useExhaustiveDependencies: fallback is compared by value
  const setShared = useCallback(
    (next: T) => ctx?.set(key, sameValue(next, fallback) ? undefined : next),
    [ctx, key, fallbackKey],
  );
  if (!ctx) return [local, setLocal];
  const stored = ctx.settings[key];
  const value = stored !== undefined && (!valid || valid(stored)) ? (stored as T) : fallback;
  return [value, setShared];
}
