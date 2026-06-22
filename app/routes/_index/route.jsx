import { redirect, Form, useLoaderData } from "react-router";
import { login } from "../../shopify.server";
import styles from "./styles.module.css";

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>PixelPerfect</h1>
        <p className={styles.text}>
          Image Optimization & SEO Suite for Shopify stores.
          Compress images, generate AI alt text, and track performance.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>AI Alt Text Generator</strong>. Generate SEO-optimized alt text for product images using Claude or OpenAI.
          </li>
          <li>
            <strong>Smart Image Compression</strong>. Reduce image sizes by up to 70% with automatic WebP conversion.
          </li>
          <li>
            <strong>Performance Reports</strong>. Track Core Web Vitals and PageSpeed improvements in real-time.
          </li>
        </ul>
      </div>
    </div>
  );
}
