/**
 * Error-toast wrapper. Sonner's default toast lifetime (~4s) is tuned for
 * transient confirmations, but CLAUDE.md requires every failed mutation to
 * stay surfaced to the user — a 4s error is easy to miss mid-typing. Sonner
 * 2.0.7 has no per-type duration on `<Toaster>` (`toastOptions.duration`
 * applies to every toast type alike), so this is the smallest fix: one
 * wrapper that gives error toasts a longer, closeable window without
 * touching success/info/warning toasts (still `toast.<type>` from "sonner"
 * directly, at the library default).
 */
import { toast } from "sonner";

type ToastErrorMessage = Parameters<typeof toast.error>[0];
type ToastErrorOptions = Parameters<typeof toast.error>[1];

const ERROR_TOAST_DURATION_MS = 8000;

export function toastError(message: ToastErrorMessage, options?: ToastErrorOptions) {
  return toast.error(message, {
    duration: ERROR_TOAST_DURATION_MS,
    closeButton: true,
    ...options,
  });
}
