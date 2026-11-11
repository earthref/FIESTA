export function ErrorMessage({ error, className }: { error: unknown; className?: string }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div
      role="alert"
      className={`rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 ${className ?? ""}`}
    >
      {message}
    </div>
  );
}
