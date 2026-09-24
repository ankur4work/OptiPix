// Product catalog for the optimizer page (server only).
//
// Extracted from app/routes/app.Productoptimization.jsx. This is the expensive
// half of that page — one Shopify request per 50 products, sequential because
// pagination is cursor-based, plus a HEAD per image that has never been
// measured. Awaiting it inside the page loader meant React Router could not
// finish the navigation until every product was in hand, so clicking "Open
// optimizer" did nothing visible for 4-10+ seconds. It now lives behind
// /api/catalog, which the page requests after it has already rendered.
import { measureSizesMB } from './optimize.server';

async function fetchProductPage(admin, cursor = null) {
  const query = `#graphql
    query GetProductsWithImages($cursor: String) {
      products(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            title
            handle
            status
            featuredImage { id url altText width height }
            images(first: 250) {
              edges { node { id url altText width height } }
            }
            metafields(first: 250, namespace: "image_optimization") {
              edges { node { key value } }
            }
          }
        }
      }
    }
  `;
  // Bound and retry this request.
  //
  // Two separate failures were killing the page. A `fetch failed` means no HTTP
  // response arrived at all (DNS, TCP, TLS, dropped socket) — not a Shopify
  // error, which comes back as a 200 with an errors array. And worse, the call
  // could hang with no result: eleven .data requests were logged with no status
  // and no duration, so the browser never navigated and "Open optimizer" looked
  // like a dead button.
  //
  // The timeout does NOT cancel the underlying request — admin.graphql takes no
  // signal, so the abandoned fetch lives until it settles on its own. That is
  // worth it: a leaked socket is cheaper than a page that never renders.
  const ATTEMPTS = 2;
  const TIMEOUT_MS = 15000;
  let lastError;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let timer;
    try {
      const response = await Promise.race([
        admin.graphql(query, { variables: { cursor } }),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Shopify did not respond within ${TIMEOUT_MS}ms`)),
            TIMEOUT_MS
          );
        }),
      ]);
      return await response.json();
    } catch (error) {
      lastError = error;
      // `cause` is where undici puts the actual reason (ENOTFOUND,
      // UND_ERR_CONNECT_TIMEOUT, ECONNRESET…). Logging only error.message threw
      // that away and left "fetch failed" as the entire diagnosis.
      console.error(
        '[CATALOG] products fetch attempt %d/%d failed: %s | cause: %s %s',
        attempt,
        ATTEMPTS,
        error?.message,
        error?.cause?.code || '',
        error?.cause?.message || ''
      );
      if (attempt < ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } finally {
      // Otherwise the losing timer keeps the event loop awake for its full
      // duration on every successful request.
      clearTimeout(timer);
    }
  }
  throw lastError;
}

async function getAllProducts(admin) {
  const allProducts = [];
  let hasNextPage = true;
  let cursor = null;
  while (hasNextPage) {
    const data = await fetchProductPage(admin, cursor);

    // A Shopify-side rejection (throttling, MAX_COST_EXCEEDED, a bad token)
    // arrives as a 200 with an errors array and no data. Reading
    // data.data.products straight away turned that into "Cannot read properties
    // of undefined", which says nothing about what Shopify actually refused.
    if (!data?.data?.products) {
      const detail = JSON.stringify(data?.errors || data).slice(0, 300);
      throw new Error('Shopify returned no product data: ' + detail);
    }

    // push rather than rebuild: spreading the accumulator each page re-copies
    // every product already fetched, which is quadratic on a large catalog.
    for (const edge of data.data.products.edges) allProducts.push(edge.node);
    hasNextPage = data.data.products.pageInfo.hasNextPage;
    cursor = data.data.products.pageInfo.endCursor;
  }
  return allProducts;
}

// Parse the optimization_summary metafield (totals written by the action).
function parseSummary(product) {
  const mf = product.metafields.edges.find(e => e.node.key === 'optimization_summary');
  if (!mf) return null;
  try {
    return JSON.parse(mf.node.value);
  } catch {
    return null;
  }
}

function countProcessed(product) {
  return product.metafields.edges.filter(e => e.node.key.startsWith('image_')).length;
}

export const EMPTY_STATS = {
  total: 0,
  needsOptimization: 0,
  optimized: 0,
  totalImages: 0,
  totalSizeMB: 0,
  potentialSavingsMB: 0,
};

// Never rejects: the page renders its chrome first and then asks for this, so a
// failure has to come back as data the page can show in a banner.
export async function buildCatalog(admin) {
  try {
    const products = await getAllProducts(admin);

    // Build a flat list of images we need to measure (only for products that
    // have never been optimized — optimized products carry totals in their
    // summary metafield). measureSizesMB serves these from the ImageSize cache
    // and only goes to the network for urls it has never seen, so this costs
    // thousands of HEAD requests exactly once rather than on every render.
    const measureTasks = [];
    for (const product of products) {
      if (parseSummary(product)) continue;
      for (const edge of product.images.edges) {
        measureTasks.push({ productId: product.id, url: edge.node.url });
      }
    }
    const sizeByUrl = await measureSizesMB(measureTasks.map(t => t.url));
    const measuredByProduct = {};
    for (const t of measureTasks) {
      measuredByProduct[t.productId] = (measuredByProduct[t.productId] || 0) + (sizeByUrl.get(t.url) || 0);
    }

    const processedProducts = products.map((product) => {
      const images = product.images.edges.map(e => e.node);
      const imageCount = images.length;
      const imagesWithAlt = images.filter(img => img.altText && img.altText.length > 10).length;

      const summary = parseSummary(product);
      let processed = summary ? (summary.optimizedImages || 0) : countProcessed(product);
      processed = Math.min(processed, imageCount);

      let totalOriginalSize;
      let totalOptimizedSize;
      if (summary) {
        totalOriginalSize = summary.totalOriginalSizeMB || 0;
        totalOptimizedSize = summary.totalOptimizedSizeMB || 0;
      } else {
        totalOriginalSize = measuredByProduct[product.id] || 0;
        totalOptimizedSize = totalOriginalSize; // nothing saved yet
      }

      const score = imageCount > 0 ? Math.round((processed / imageCount) * 100) : 0;
      const sizeSavedMB = Math.max(0, totalOriginalSize - totalOptimizedSize);
      const compressionRate = totalOriginalSize > 0
        ? Math.max(0, Math.round((sizeSavedMB / totalOriginalSize) * 100))
        : 0;

      return {
        id: product.id,
        title: product.title,
        handle: product.handle,
        status: product.status,
        imageCount,
        imagesWithAlt,
        optimizedImages: processed,
        score,
        totalOriginalSizeMB: totalOriginalSize,
        totalOptimizedSizeMB: totalOptimizedSize,
        sizeSavedMB,
        compressionRate,
        featuredImageUrl: product.featuredImage?.url || images[0]?.url,
        needsOptimization: score < 100,
      };
    });

    // Return ALL products; filtering/sorting happens instantly on the client
    // from this list, so changing a filter never re-runs this (heavy) fetch.
    return {
      products: processedProducts,
      stats: {
        total: processedProducts.length,
        needsOptimization: processedProducts.filter(p => p.needsOptimization).length,
        optimized: processedProducts.filter(p => !p.needsOptimization).length,
        totalImages: processedProducts.reduce((s, p) => s + p.imageCount, 0),
        totalSizeMB: processedProducts.reduce((s, p) => s + p.totalOriginalSizeMB, 0),
        potentialSavingsMB: processedProducts.reduce((s, p) => s + p.sizeSavedMB, 0),
      },
      error: null,
    };
  } catch (error) {
    console.error(
      '[CATALOG] Error loading products: %s | cause: %s %s',
      error?.message,
      error?.cause?.code || '',
      error?.cause?.message || ''
    );
    return { products: [], stats: EMPTY_STATS, error: 'Failed to load products' };
  }
}
