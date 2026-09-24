import { authenticate } from '../shopify.server';
import { buildCatalog } from '../catalog.server';

/**
 * The product catalog the optimizer page renders.
 *
 * A resource route (no default export) so the page can ask for it AFTER it has
 * painted. Building this list takes seconds — one Shopify request per 50
 * products, sequential because pagination is cursor-based, plus a HEAD per
 * never-measured image — and while it lived in the page loader, React Router
 * could not complete the navigation until it finished. The click looked dead for
 * 4-10+ seconds. Now the page renders instantly and fills in when this returns.
 *
 * Keeping it out of the page loader also makes `revalidator.revalidate()` cheap:
 * refreshing the usage meter after a run no longer re-fetches the whole catalog.
 */

export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  // A plain object, not a hand-rolled Response: the page reads this with
  // fetcher.load(), which goes through React Router's single-fetch endpoint and
  // serializes the returned value itself.
  //
  // buildCatalog never rejects — a failure comes back as { error } so the page
  // can show a banner instead of an error boundary.
  return await buildCatalog(admin);
}
