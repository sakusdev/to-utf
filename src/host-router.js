import worker from "./index.js";

const MARKDOWN_HOST = "md.2utf.sakus.org";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (
      url.hostname.toLowerCase() === MARKDOWN_HOST &&
      !url.searchParams.has("format")
    ) {
      url.searchParams.set("format", "markdown");
      request = new Request(url, request);
    }

    return worker.fetch(request, env, ctx);
  },
};
