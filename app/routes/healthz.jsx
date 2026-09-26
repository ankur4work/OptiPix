/**
 * Readiness probe: /healthz
 *
 * Coolify had no health check for this app, so on every deploy it pointed the
 * proxy at the new container the moment Docker started it. The container does
 * not serve anything until `prisma db push` has finished and
 * react-router-serve has bound port 3000, so requests arriving in that window
 * had no listener to reach and hung until the browser gave up.
 *
 * With this endpoint configured as the health check, the proxy only sends
 * traffic once the server is actually answering, and the old container keeps
 * serving until then.
 *
 * Deliberately does NOT touch the database or Shopify: it answers the one
 * question the proxy is asking — is this process ready to take a request.
 */
export function loader() {
  return new Response('ok', {
    status: 200,
    headers: {
      'Content-Type': 'text/plain',
      'Cache-Control': 'no-store',
    },
  });
}
