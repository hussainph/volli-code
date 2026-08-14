/**
 * Shared chrome of the Session composer and anything stacked on it
 * (ask-user card, later plans and subagent activity). The overlay sits
 * *above* the input and never replaces it; both shells use this radius so
 * they read as one family.
 */
export const COMPOSER_STACK_SHELL =
  "rounded-2xl border border-border bg-card shadow-[var(--shadow-raised)]";
