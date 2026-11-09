# prgenie.ai static site

Plain HTML and CSS for the PR Genie landing page. No build step.

## Local preview

From this directory:

```bash
python3 -m http.server 8080
```

Open http://127.0.0.1:8080/

## Cloudflare Pages

1. In Cloudflare Pages, connect the [radiancelux/prgenie](https://github.com/radiancelux/prgenie) repository.
2. **Build command:** leave empty.
3. **Build output directory:** `site`
4. Attach the custom domain `prgenie.ai` (and optionally redirect `www` to the apex) in the Cloudflare dashboard.

No environment variables or secrets are required for this static deploy.
