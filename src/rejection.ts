export type RejectionReason =
  "already_thanked" | "quota_exhausted" | "not_eligible" | "protocol_error" | "other";

export type ClassifyRejection = (message: string) => Promise<RejectionReason>;

const LIVEWIRE_PROTOCOL_ERRORS = [/component payload was altered/i, /wrong component/i];

export const classifyRejection: ClassifyRejection = (message) =>
  Promise.resolve(
    LIVEWIRE_PROTOCOL_ERRORS.some((pattern) => pattern.test(message)) ? "protocol_error" : "other",
  );
