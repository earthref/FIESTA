/**
 * Assistance requests (GET/POST /private/requests, /private/contributions/{id}/requests):
 * a user asks the node's admins for help with one of their contributions, and
 * the admins work through the open ones on the workspace's Requests tab.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type { ContributionOut } from "./types";

export type RequestReason = "approve" | "reassign" | "validation" | "other";

export const REQUEST_REASONS: Record<RequestReason, string> = {
  approve: "Approve a new version",
  reassign: "Reassign this contribution",
  validation: "Trouble validating",
  other: "Other",
};

export interface AssistanceRequest {
  id: number;
  contribution_id: number;
  requester_id: number;
  requester_name: string | null;
  requester_handle: string | null;
  reason: RequestReason;
  message: string;
  state: "open" | "withdrawn" | "resolved";
  created_at: string;
  closed_at: string | null;
  closed_by: number | null;
  closed_by_name: string | null;
  note: string | null;
  /** With scope=node: the contribution and its head revision's validation. */
  contribution?: ContributionOut | null;
  validation?: {
    is_valid: boolean;
    errors: number;
    warnings: number;
    validated_at: string;
  } | null;
}

export const requestsKey = ["private", "requests"] as const;

/** The caller's requests (made by them or on their contributions), newest first. */
export function useMyRequests(enabled: boolean) {
  return useQuery({
    queryKey: [...requestsKey, "mine"],
    queryFn: () => api<AssistanceRequest[]>("/private/requests", { params: { scope: "mine" } }),
    enabled,
  });
}

/** Every open request on the node (node admins only). */
export function useNodeRequests(enabled: boolean) {
  return useQuery({
    queryKey: [...requestsKey, "node"],
    queryFn: () =>
      api<AssistanceRequest[]>("/private/requests", { params: { scope: "node", state: "open" } }),
    enabled,
    refetchInterval: 60_000,
  });
}

/** Each contribution's latest request, from a newest-first list. */
export function latestByContribution(requests: AssistanceRequest[] | undefined) {
  const latest = new Map<number, AssistanceRequest>();
  for (const request of requests ?? []) {
    if (!latest.has(request.contribution_id)) latest.set(request.contribution_id, request);
  }
  return latest;
}

/** "3 days ago" style age. */
export function age(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 60) return minutes <= 1 ? "just now" : `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}
