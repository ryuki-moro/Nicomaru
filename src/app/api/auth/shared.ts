export function appBaseUrl(request: Request): string {
  const configured = process.env.APP_BASE_URL;
  if (configured) return configured.replace(/\/+$/, '');
  return new URL(request.url).origin;
}
