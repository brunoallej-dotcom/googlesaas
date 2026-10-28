import { AlertTriangle, X } from 'lucide-react';

interface ErrorBannerProps {
  readonly message: string;
  readonly onDismiss: () => void;
}

export function ErrorBanner({ message, onDismiss }: ErrorBannerProps): React.JSX.Element {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-xl border border-gmn-danger/40 bg-gmn-danger/10 p-4 text-sm text-red-200"
    >
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-gmn-danger" aria-hidden="true" />
      <p className="min-w-0 flex-1 break-words">{message}</p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dispensar mensagem de erro"
        className="rounded-md p-1 text-red-200 hover:bg-gmn-danger/20"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
