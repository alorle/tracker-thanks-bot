export type RejectionReason = "already_thanked" | "quota_exhausted" | "not_eligible" | "other";

export type ClassifyRejection = (message: string) => Promise<RejectionReason>;

export const classifyRejection: ClassifyRejection = () => Promise.resolve("other");
